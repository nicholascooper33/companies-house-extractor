#!/usr/bin/env node

/**
 * MCP Server for Companies House API
 *
 * This server exposes Companies House data to Claude Desktop via MCP.
 *
 * Setup:
 * 1. Add to Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json on Mac):
 *    {
 *      "mcpServers": {
 *        "companies-house": {
 *          "command": "node",
 *          "args": ["/path/to/companies-house-extractor/mcp-server.js"],
 *          "env": {
 *            "COMPANIES_HOUSE_API_KEY": "your-api-key"
 *          }
 *        }
 *      }
 *    }
 * 2. Restart Claude Desktop
 */

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

// Tool implementations
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
    description: 'Get the latest filed accounts for a company. Returns the most recent account filings with links to view the documents.',
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

          let description = filing.description || 'Accounts';
          if (filing.description_values) {
            for (const [key, value] of Object.entries(filing.description_values)) {
              description = description.replace(`{${key}}`, value);
            }
          }

          return {
            date: filing.date,
            description: description.replace(/-/g, ' '),
            made_up_date: filing.description_values?.made_up_date || null,
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

// MCP Protocol implementation
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function handleRequest(request) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0') {
    return sendResponse({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
  }

  switch (method) {
    case 'initialize':
      sendResponse({
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
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          tools: Object.entries(tools).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }))
        }
      });
      break;

    case 'tools/call':
      const { name, arguments: args } = params;
      const tool = tools[name];
      if (!tool) {
        sendResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` }
        });
        return;
      }

      tool.handler(args || {})
        .then(result => {
          sendResponse({
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
          });
        })
        .catch(error => {
          sendResponse({
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
          });
        });
      break;

    default:
      sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
  }
}

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    handleRequest(request);
  } catch (error) {
    sendResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
  }
});

// Handle process signals
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
