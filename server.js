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
