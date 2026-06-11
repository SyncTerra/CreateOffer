
import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

const DRIVE_ADMIN_SCRIPT_URL = process.env.DRIVE_ADMIN_SCRIPT_URL;
const DRIVE_ADMIN_SCRIPT_SECRET = process.env.DRIVE_ADMIN_SCRIPT_SECRET;

const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || '';

if (!APPS_SCRIPT_URL) {
  throw new Error('Missing env var: APPS_SCRIPT_URL');
}

if (!APPS_SCRIPT_SECRET) {
  throw new Error('Missing env var: APPS_SCRIPT_SECRET');
}

if (!DRIVE_ADMIN_SCRIPT_URL) {
  throw new Error('Missing env var: DRIVE_ADMIN_SCRIPT_URL');
}

if (!DRIVE_ADMIN_SCRIPT_SECRET) {
  throw new Error('Missing env var: DRIVE_ADMIN_SCRIPT_SECRET');
}

const app = express();
app.use(express.json({ limit: '2mb' }));

function checkBearerAuth(req, res, next) {
  if (!MCP_BEARER_TOKEN) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const expected = 'Bearer ' + MCP_BEARER_TOKEN;

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

async function callGoogleScript(url, secret, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      secret: secret,
      ...payload
    })
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error('Google Apps Script returned non-JSON response: ' + text);
  }

  if (!response.ok) {
    throw new Error('Google Apps Script HTTP error ' + response.status + ': ' + text);
  }

  return data;
}

async function callCreateOffer(payload) {
  return callGoogleScript(APPS_SCRIPT_URL, APPS_SCRIPT_SECRET, payload);
}

async function callDriveAdmin(payload) {
  return callGoogleScript(DRIVE_ADMIN_SCRIPT_URL, DRIVE_ADMIN_SCRIPT_SECRET, payload);
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
  lead_id: z.string().optional().describe('Lead ID from CRM, for example ST-20260611-1030'),
  name: z.string().optional().describe('Client name or company name from CRM, for example Jan Kowalski'),
  phone: z.string().optional().describe('Client phone number from CRM, for example +48 500 600 700'),
  email: z.string().optional().describe('Client email address from CRM')
};

function createMcpServer() {
  const server = new McpServer({
    name: 'SyncTerra Automation',
    version: '1.2.2'
  });

  server.tool(
    'find_lead',
    'Find a CRM lead by Lead ID, client name, phone, or email. If multiple leads match, returns candidates and does not choose automatically.',
    LeadInputSchema,
    async (input) => {
      const result = await callCreateOffer({
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
      const result = await callCreateOffer({
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
      const result = await callCreateOffer({
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
      const result = await callCreateOffer({
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
      clean_optional_pages: z.boolean().optional().describe('If true, remove unused Sliding Glass / ZIP pages. Default false.'),
      replacements: z.record(z.string()).optional().describe('Optional placeholder replacements.')
    },
    async (input) => {
      const result = await callCreateOffer({
        action: 'update_offer_draft',
        ...buildLeadPayload(input),
        clean_optional_pages: input.clean_optional_pages || false,
        replacements: input.replacements || {}
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'create_offer_version',
    'Create a new explicit version of the offer only when the manager requested a new version, v2, or alternative variant. Accepts Lead ID, client name, phone, or email.',
    {
      ...LeadInputSchema,
      version_label: z.string().optional().describe('Version label, for example v2 or wariant_tanszy')
    },
    async (input) => {
      const result = await callCreateOffer({
        action: 'create_offer_version',
        ...buildLeadPayload(input),
        version_label: input.version_label || 'v2'
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_list_folder',
    'List files and folders inside an allowed SyncTerra Google Drive folder.',
    {
      folder_id: z.string().describe('Google Drive folder ID')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'list_folder',
        folder_id: input.folder_id
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_get_file',
    'Get metadata for a file inside allowed SyncTerra folders.',
    {
      file_id: z.string().describe('Google Drive file ID')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'get_file',
        file_id: input.file_id
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_create_folder',
    'Create a folder inside an allowed SyncTerra folder.',
    {
      parent_id: z.string().describe('Parent folder ID'),
      name: z.string().describe('New folder name')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'create_folder',
        parent_id: input.parent_id,
        name: input.name
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_rename_file',
    'Rename a file inside allowed SyncTerra folders.',
    {
      file_id: z.string().describe('Google Drive file ID'),
      new_name: z.string().describe('New file name')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'rename_file',
        file_id: input.file_id,
        new_name: input.new_name
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_move_file',
    'Move a file to another allowed SyncTerra folder.',
    {
      file_id: z.string().describe('Google Drive file ID'),
      target_folder_id: z.string().describe('Target Google Drive folder ID')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'move_file',
        file_id: input.file_id,
        target_folder_id: input.target_folder_id
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_copy_file',
    'Copy a file into an allowed SyncTerra folder.',
    {
      file_id: z.string().describe('Source Google Drive file ID'),
      target_folder_id: z.string().describe('Target Google Drive folder ID'),
      new_name: z.string().optional().describe('Optional new name for the copied file')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'copy_file',
        file_id: input.file_id,
        target_folder_id: input.target_folder_id,
        new_name: input.new_name
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_trash_file',
    'Move a file to Google Drive trash. This does not permanently delete it.',
    {
      file_id: z.string().describe('Google Drive file ID')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'trash_file',
        file_id: input.file_id
      });

      return asMcpText(result);
    }
  );

server.tool(
  'drive_trash_folder',
  'Move a folder to Google Drive trash. This does not permanently delete it.',
  {
    folder_id: z.string().describe('Google Drive folder ID')
  },
  async (input) => {
    const result = await callDriveAdmin({
      action: 'trash_folder',
      folder_id: input.folder_id
    });

    return asMcpText(result);
  }
);

server.tool(
  'drive_restore_folder',
  'Restore a folder from Google Drive trash.',
  {
    folder_id: z.string().describe('Google Drive folder ID')
  },
  async (input) => {
    const result = await callDriveAdmin({
      action: 'restore_folder',
      folder_id: input.folder_id
    });

    return asMcpText(result);
  }
);
  server.tool(
    'drive_restore_file',
    'Restore a file from Google Drive trash.',
    {
      file_id: z.string().describe('Google Drive file ID')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'restore_file',
        file_id: input.file_id
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_export_pdf',
    'Export a Google Docs, Sheets, or Slides file as PDF into an allowed SyncTerra folder.',
    {
      file_id: z.string().describe('Source Google Drive file ID'),
      target_folder_id: z.string().describe('Target folder ID for the PDF'),
      pdf_name: z.string().optional().describe('Optional PDF file name')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'export_pdf',
        file_id: input.file_id,
        target_folder_id: input.target_folder_id,
        pdf_name: input.pdf_name
      });

      return asMcpText(result);
    }
  );

  server.tool(
    'drive_replace_text',
    'Replace text in a Google Docs, Slides, or Sheets file inside allowed SyncTerra folders.',
    {
      file_id: z.string().describe('Google Drive file ID'),
      find_text: z.string().describe('Text to find'),
      replace_with: z.string().describe('Replacement text')
    },
    async (input) => {
      const result = await callDriveAdmin({
        action: 'replace_text',
        file_id: input.file_id,
        find_text: input.find_text,
        replace_with: input.replace_with
      });

      return asMcpText(result);
    }
  );

  return server;
}

app.get('/health', function (req, res) {
  res.json({
    ok: true,
    service: 'syncterra-automation-mcp',
    version: '1.2.2',
    modules: ['create_offer', 'drive_admin']
  });
});

app.post('/mcp', checkBearerAuth, async function (req, res) {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on('close', function () {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, function () {
  console.log('SyncTerra Automation MCP running on port ' + PORT);
});

