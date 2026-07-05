import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(".", { index: "index.html" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const NOTION_VERSION = "2022-06-28";

if (!OPENAI_API_KEY) console.warn("⚠️  Falta OPENAI_API_KEY en variables de entorno");
if (!NOTION_TOKEN) console.warn("⚠️  Falta NOTION_TOKEN en variables de entorno");

// ---------- Helpers de Notion ----------

async function notionRequest(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Notion API error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function textBlock(text) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }] },
  };
}

function extractPlainText(richTextArray = []) {
  return richTextArray.map((t) => t.plain_text || "").join("");
}

// ---------- Herramientas disponibles para la IA ----------

const tools = [
  {
    type: "function",
    function: {
      name: "search_notion",
      description: "Busca páginas o bases de datos en Notion por texto.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Texto a buscar" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_content",
      description: "Obtiene el título y el contenido (texto) de una página de Notion dado su ID.",
      parameters: {
        type: "object",
        properties: { page_id: { type: "string" } },
        required: ["page_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_page",
      description: "Crea una nueva página de Notion dentro de otra página (parent_page_id), con título y contenido inicial.",
      parameters: {
        type: "object",
        properties: {
          parent_page_id: { type: "string", description: "ID de la página donde se creará la nueva página" },
          title: { type: "string" },
          content: { type: "string", description: "Texto del contenido inicial (opcional)" },
        },
        required: ["parent_page_id", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_to_page",
      description: "Agrega texto/contenido al final de una página existente.",
      parameters: {
        type: "object",
        properties: {
          page_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["page_id", "content"],
      },
    },
{ type: "function", function: { name: "query_database", description: "Consulta filas de una base de datos.", parameters: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"] } } },
  { type: "function", function: { name: "create_database_item", description: "Crea un elemento en una base de datos.", parameters: { type: "object", properties: { database_id: { type: "string" }, properties: { type: "object" } }, required: ["database_id", "properties"] } } },
];async function runTool(name, args) {
  switch (name) {
    case "search_notion": {
      const data = await notionRequest("POST", "/search", { query: args.query });
      return data.results.slice(0, 10).map((r) => ({
        id: r.id,
        type: r.object,
        title: r.properties?.title?.title?.[0]?.plain_text || r.properties?.Name?.title?.[0]?.plain_text || extractPlainText(r.properties?.title?.title) || "sin titulo",
        url: r.url,
      }));
    }
    case "get_page_content": {
      const page = await notionRequest("GET", `/pages/${args.page_id}`);
      const blocks = await notionRequest("GET", `/blocks/${args.page_id}/children?page_size=100`);
      const title = page.properties?.title?.title?.[0]?.plain_text || page.properties?.Name?.title?.[0]?.plain_text || "sin titulo";
      const content = blocks.results.map((b) => extractPlainText(b[b.type]?.rich_text)).filter(Boolean).join("\n");
      return { title, content };
    }
    case "create_page": {
      const children = args.content ? [textBlock(args.content)] : [];
      const page = await notionRequest("POST", "/pages", {
        parent: { page_id: args.parent_page_id },
        properties: { title: { title: [{ text: { content: args.title } }] } },
        children,
      });
      return { id: page.id, url: page.url };
    }
    case "append_to_page": {
      await notionRequest("PATCH", `/blocks/${args.page_id}/children`, { children: [textBlock(args.content)] });
      return { ok: true };
    }
    case "query_database": {
      const data = await notionRequest("POST", `/databases/${args.database_id}/query`, {});
      return data.results.slice(0, 20).map((r) => ({
        id: r.id,
        properties: Object.fromEntries(Object.entries(r.properties).map(([k, v]) => [k, v.title ? extractPlainText(v.title) : v.rich_text ? extractPlainText(v.rich_text) : v.select?.name || v.status?.name || v.date?.start || null])),
      }));
    }
    case "create_database_item": {
      const page = await notionRequest("POST", "/pages", { parent: { database_id: args.database_id }, properties: args.properties });
      return { id: page.id, url: page.url };
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    const systemMessage = {
      role: "system",
      content: "Eres un asistente que ayuda al usuario a leer, crear y editar contenido en su Notion. Usa las herramientas disponibles cuando el usuario pida buscar, resumir, crear o modificar algo en Notion. Si necesitas un page_id o database_id que no tienes, primero usa search_notion para encontrarlo. Responde siempre en espanol, de forma clara y breve.",
    };
    let conversation = [systemMessage, ...messages];
    let finalMessage = null;
    for (let i = 0; i < 6; i++) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: OPENAI_MODEL, messages: conversation, tools }),
      });
      const data = await response.json();
      if (data.error) {
        return res.status(500).json({ error: data.error.message });
      }
      const choice = data.choices[0];
      const msg = choice.message;
      conversation.push(msg);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          let result;
          try {
            const args = JSON.parse(call.function.arguments || "{}");
            result = await runTool(call.function.name, args);
          } catch (err) {
            result = { error: err.message };
          }
          conversation.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
        continue;
      }
      finalMessage = msg.content;
      break;
    }
    res.json({ reply: finalMessage || "No pude completar la solicitud, intenta de nuevo." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
