import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// Optional protection for your MCP endpoint.
// Leave empty for first test if ChatGPT Custom MCP is set to "No authentication".
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || '';

if (!APPS_SCRIPT_URL) {
  throw new Error('Missing env var: APPS_SCRIPT_URL');
}

if (!APPS_SCRIPT_SECRET) {
  throw new Error('Missing env var: APPS_SCRIPT_SECRET');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

function checkBearerAuth(req, res, next) {
  if (!MCP_BEARER_TOKEN) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const expected = `Bearer ${MCP_BEARER_TOKEN}`;

  if (authHeader !== expected) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized'
    });
  }

  return next();
}

function buildLeadPayload(input) {
  const payload = {};

  if (input.lead_id) {
    payload.lead_id = input.lead_id;
  }

  if (input.name) {
    payload.name = input.name;
  }

  if (input.phone) {
    payload.phone = input.phone;
  }

  if (input.email) {
    payload.email = input.email;
  }

  return payload;
}

async function callAppsScript(payload) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      secret: APPS_SCRIPT_SECRET,
      ...payload
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Apps Script returned non-JSON response: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Apps Script HTTP error ${response.status}: ${text}`);
  }

  return data;
}

function asMcpText(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

const LeadInputSchema = {
  lead_id: z
    .string()
    .optional()
    .describe('Lead ID from CRM, for example ST-20260611-1030'),
  name: z
    .string()
    .optional()
    .describe('Client name or company name from CRM, for example Jan Kowalski'),
  phone: z
    .string()
    .optional()
    .describe('Client phone number from CRM, for example +48 500 600 700'),
  email: z
    .string()
    .optional()
    .describe('Client email address from CRM')
};

function createMcpServer() {
  const server = new McpServer({
    name: 'SyncTerra Offer Automation',
    version: '1.1.0'
  });

  server.tool(
    'find_lead',
    'Find a CRM lead by Lead ID, client name, phone, or email. If multiple leads match, returns candidates and does not choose automatically.',
    LeadInputSchema,
    async (input) => {
      const result = await callAppsScript({
        action: 'find_lead',
        ...buildLeadPayload(input)
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'get_offer_status',
    'Check whether a CRM lead already has an offer link. Accepts Lead ID, client name, phone, or email.',
    LeadInputSchema,
    async (input) => {
      const result = await callAppsScript({
        action: 'get_offer_status',
        ...buildLeadPayload(input)
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'create_or_update_offer_draft',
    'Create the first offer draft if no offer exists, or update the same existing Google Slides offer if CRM Oferta link already exists. Accepts Lead ID, client name, phone, or email. Does not create duplicates.',
    LeadInputSchema,
    async (input) => {
      const result = await callAppsScript({
        action: 'create_or_update_offer_draft',
        ...buildLeadPayload(input)
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'create_offer_draft',
    'Create the first offer draft only if CRM Oferta link is empty. If an offer already exists, do not create a new copy. Accepts Lead ID, client name, phone, or email.',
    LeadInputSchema,
    async (input) => {
      const result = await callAppsScript({
        action: 'create_offer_draft',
        ...buildLeadPayload(input)
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'update_offer_draft',
    'Update the existing offer linked in CRM Oferta link. This does not create a new file. Accepts Lead ID, client name, phone, or email.',
    {
      ...LeadInputSchema,
      clean_optional_pages: z
        .boolean()
        .optional()
        .describe('If true, remove unused Sliding Glass / ZIP pages. Default false.'),
      replacements: z
        .record(z.string())
        .optional()
        .describe('Optional placeholder replacements, for example {"{{PRICE_BADGE}}":"draft po aktualizacji"}')
    },
    async (input) => {
      const {
        clean_optional_pages = false,
        replacements = {}
      } = input;

      const result = await callAppsScript({
        action: 'update_offer_draft',
        ...buildLeadPayload(input),
        clean_optional_pages,
        replacements
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'create_offer_version',
    'Create a new explicit version of the offer only when the manager requested a new version, v2, or alternative variant. Accepts Lead ID, client name, phone, or email.',
    {
      ...LeadInputSchema,
      version_label: z
        .string()
        .optional()
        .describe('Version label, for example v2 or wariant_tanszy')
    },
    async (input) => {
      const result = await callAppsScript({
        action: 'create_offer_version',
        ...buildLeadPayload(input),
        version_label: input.version_label || 'v2'
      });

      return asMcpText(result);
    }
  );

  return server;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'syncterra-offer-mcp',
    version: '1.1.0'
  });
});

app.post('/mcp', checkBearerAuth, async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`SyncTerra Offer MCP running on port ${PORT}`);
});