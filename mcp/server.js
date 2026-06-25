#!/usr/bin/env node

/**
 * MCP Server for Companies House API (HTTP/SSE version for remote deployment)
 *
 * Deploy on Railway and connect via Claude web interface.
 */

const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3002;
const CH_API_BASE = 'https://api.company-information.service.gov.uk';

// API helper function
async function fetchFromCompaniesHouse(endpoint) {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    throw new Error('COMPANIES_HOUSE_API_KEY environment variable not set');
  }

  const response = await fetch(`${CH_API_BASE}${endpoint}`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64')
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Companies House API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// Format address helper
function formatAddress(address) {
  if (!address) return 'N/A';
  const parts = [
    address.premises,
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country
  ].filter(Boolean);
  return parts.join(', ') || 'N/A';
}

// Tool definitions
const tools = {
  search_company: {
    description: 'Search for companies by name or number',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Company name or number to search for'
        }
      },
      required: ['query']
    },
    handler: async ({ query }) => {
      const data = await fetchFromCompaniesHouse(`/search/companies?q=${encodeURIComponent(query)}&items_per_page=10`);
      const results = (data.items || []).map(c => ({
        name: c.title,
        number: c.company_number,
        status: c.company_status,
        address: formatAddress(c.address)
      }));
      return { results };
    }
  },

  get_company: {
    description: 'Get detailed information about a specific company by company number',
    inputSchema: {
      type: 'object',
      properties: {
        company_number: {
          type: 'string',
          description: 'The company number (e.g., 12345678)'
        }
      },
      required: ['company_number']
    },
    handler: async ({ company_number }) => {
      const data = await fetchFromCompaniesHouse(`/company/${company_number}`);
      return {
        name: data.company_name,
        number: data.company_number,
        status: data.company_status,
        type: data.type,
        incorporated: data.date_of_creation,
        dissolved: data.date_of_cessation || null,
        address: formatAddress(data.registered_office_address),
        sic_codes: data.sic_codes || []
      };
    }
  },

  get_company_accounts: {
    description: 'Get the latest filed accounts for a company. Returns the most recent account filings with links to view the PDF documents.',
    inputSchema: {
      type: 'object',
      properties: {
        company_number: {
          type: 'string',
          description: 'The company number (e.g., 12345678)'
        },
        limit: {
          type: 'number',
          description: 'Number of account filings to return (default: 2, max: 10)'
        }
      },
      required: ['company_number']
    },
    handler: async ({ company_number, limit = 2 }) => {
      const filingHistory = await fetchFromCompaniesHouse(
        `/company/${company_number}/filing-history?items_per_page=100&category=accounts`
      );

      const accountsFilings = (filingHistory.items || [])
        .filter(filing => {
          const type = (filing.type || '').toLowerCase();
          const description = (filing.description || '').toLowerCase();
          return type.includes('aa') ||
                 description.includes('accounts') ||
                 description.includes('full accounts') ||
                 description.includes('micro-entity') ||
                 description.includes('small company') ||
                 description.includes('dormant') ||
                 description.includes('abbreviated');
        })
        .slice(0, Math.min(limit, 10))
        .map(filing => {
          let documentUrl = null;
          if (filing.links?.document_metadata) {
            documentUrl = `https://find-and-update.company-information.service.gov.uk/company/${company_number}/filing-history/${filing.transaction_id}/document?format=pdf&download=0`;
          }

          const year = filing.description_values?.made_up_date
            ? new Date(filing.description_values.made_up_date).getFullYear()
            : null;

          return {
            title: year ? `${year} accounts` : 'Accounts',
            filed_date: filing.date,
            year_ending: filing.description_values?.made_up_date || null,
            document_url: documentUrl
          };
        });

      return {
        company_number,
        accounts: accountsFilings
      };
    }
  },

  get_company_officers: {
    description: 'Get the current officers (directors, secretaries) of a company',
    inputSchema: {
      type: 'object',
      properties: {
        company_number: {
          type: 'string',
          description: 'The company number (e.g., 12345678)'
        },
        include_resigned: {
          type: 'boolean',
          description: 'Whether to include resigned officers (default: false)'
        }
      },
      required: ['company_number']
    },
    handler: async ({ company_number, include_resigned = false }) => {
      const data = await fetchFromCompaniesHouse(`/company/${company_number}/officers?items_per_page=100`);
      let officers = data.items || [];

      if (!include_resigned) {
        officers = officers.filter(o => !o.resigned_on);
      }

      return {
        officers: officers.map(o => ({
          name: o.name,
          role: (o.officer_role || '').replace(/-/g, ' '),
          appointed: o.appointed_on,
          resigned: o.resigned_on || null,
          nationality: o.nationality,
          occupation: o.occupation,
          address: formatAddress(o.address)
        }))
      };
    }
  },

  get_company_pscs: {
    description: 'Get the persons with significant control (PSCs) / beneficial owners of a company',
    inputSchema: {
      type: 'object',
      properties: {
        company_number: {
          type: 'string',
          description: 'The company number (e.g., 12345678)'
        }
      },
      required: ['company_number']
    },
    handler: async ({ company_number }) => {
      const data = await fetchFromCompaniesHouse(`/company/${company_number}/persons-with-significant-control`);
      const pscs = (data.items || []).filter(p => !p.ceased_on);

      return {
        pscs: pscs.map(p => ({
          name: p.name,
          type: (p.kind || '').replace(/-/g, ' ').replace('person with significant control', 'PSC'),
          natures_of_control: (p.natures_of_control || []).map(n =>
            n.replace(/-/g, ' ')
             .replace(/ownership of shares/i, 'Owns')
             .replace(/voting rights/i, 'Voting rights')
             .replace(/percent/i, '%')
          ),
          nationality: p.nationality,
          country_of_residence: p.country_of_residence,
          address: formatAddress(p.address)
        }))
      };
    }
  }
};

// Store active SSE connections
const sseConnections = new Map();

// Handle MCP JSON-RPC request
async function handleMCPRequest(request) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'companies-house',
            version: '1.0.0'
          }
        }
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: Object.entries(tools).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        }
      };

    case 'tools/call':
      const { name, arguments: args } = params;
      const tool = tools[name];
      if (!tool) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` }
        };
      }

      try {
        const result = await tool.handler(args || {});
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }
            ]
          }
        };
      } catch (error) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Error: ${error.message}`
              }
            ],
            isError: true
          }
        };
      }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
  }
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'companies-house-mcp' }));
    return;
  }

  // SSE endpoint for MCP
  if (url.pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const sessionId = Date.now().toString();
    sseConnections.set(sessionId, res);

    // Send endpoint info
    res.write(`data: ${JSON.stringify({ type: 'endpoint', url: `/message?sessionId=${sessionId}` })}\n\n`);

    req.on('close', () => {
      sseConnections.delete(sessionId);
    });

    return;
  }

  // Message endpoint for MCP requests
  if (url.pathname === '/message' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const sseRes = sseConnections.get(sessionId);

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        const response = await handleMCPRequest(request);

        // Send response via SSE if connection exists
        if (sseRes && !sseRes.writableEnded) {
          sseRes.write(`data: ${JSON.stringify(response)}\n\n`);
        }

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'accepted' }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });

    return;
  }

  // Direct JSON-RPC endpoint (simpler alternative)
  if (url.pathname === '/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        const response = await handleMCPRequest(request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    });

    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.COMPANIES_HOUSE_API_KEY}`);
});
