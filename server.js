/**
 * Production server for Companies House Extractor
 * Serves both the API and the built frontend from a single process
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const CH_API_BASE = 'https://api.company-information.service.gov.uk';

app.use(cors());
app.use(express.json());

// Serve static frontend files (built React app)
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// API helper function
async function fetchFromCompaniesHouse(endpoint) {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) {
    throw new Error('Companies House API key not configured');
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

// Search companies
app.get('/api/search', async (req, res) => {
  try {
    const { q, items_per_page = 20 } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    const data = await fetchFromCompaniesHouse(
      `/search/companies?q=${encodeURIComponent(q)}&items_per_page=${items_per_page}`
    );
    res.json(data);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get company profile
app.get('/api/company/:companyNumber', async (req, res) => {
  try {
    const data = await fetchFromCompaniesHouse(`/company/${req.params.companyNumber}`);
    res.json(data);
  } catch (error) {
    console.error('Company profile error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get company officers (paginated to fetch up to 1000)
app.get('/api/company/:companyNumber/officers', async (req, res) => {
  try {
    const maxOfficers = 1000;
    const pageSize = 100; // Companies House API max per request
    let allItems = [];
    let startIndex = 0;
    let totalResults = 0;

    // Fetch first page to get total count
    const firstPage = await fetchFromCompaniesHouse(
      `/company/${req.params.companyNumber}/officers?items_per_page=${pageSize}&start_index=0`
    );

    allItems = firstPage.items || [];
    totalResults = firstPage.total_results || allItems.length;

    // Fetch remaining pages if needed (up to maxOfficers)
    while (allItems.length < totalResults && allItems.length < maxOfficers) {
      startIndex += pageSize;
      const nextPage = await fetchFromCompaniesHouse(
        `/company/${req.params.companyNumber}/officers?items_per_page=${pageSize}&start_index=${startIndex}`
      );
      if (!nextPage.items || nextPage.items.length === 0) break;
      allItems = allItems.concat(nextPage.items);
    }

    res.json({
      ...firstPage,
      items: allItems.slice(0, maxOfficers),
      items_per_page: allItems.length,
      total_results: totalResults
    });
  } catch (error) {
    console.error('Officers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get persons with significant control
app.get('/api/company/:companyNumber/pscs', async (req, res) => {
  try {
    const data = await fetchFromCompaniesHouse(
      `/company/${req.params.companyNumber}/persons-with-significant-control`
    );
    res.json(data);
  } catch (error) {
    console.error('PSC error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Recursive function to trace corporate ownership chain
async function traceOwnershipChain(companyNumber, depth = 0, visited = new Set()) {
  // Prevent infinite loops (circular ownership)
  if (visited.has(companyNumber)) {
    return { company_number: companyNumber, circular_reference: true, depth };
  }

  visited.add(companyNumber);

  try {
    // Get company profile
    const companyProfile = await fetchFromCompaniesHouse(`/company/${companyNumber}`);

    // Get PSCs for this company
    let pscs = { items: [] };
    try {
      pscs = await fetchFromCompaniesHouse(
        `/company/${companyNumber}/persons-with-significant-control`
      );
    } catch (e) {
      // Some companies may not have PSC data
      console.log(`No PSC data for ${companyNumber}`);
    }

    const result = {
      company_number: companyNumber,
      company_name: companyProfile.company_name,
      company_status: companyProfile.company_status,
      depth: depth,
      pscs: []
    };

    // Process each PSC
    if (pscs.items) {
      for (const psc of pscs.items) {
        // Skip ceased PSCs
        if (psc.ceased_on) continue;

        const pscInfo = {
          name: psc.name,
          kind: psc.kind,
          natures_of_control: psc.natures_of_control || [],
          address: psc.address
        };

        // Check if this is a corporate entity
        if (psc.kind === 'corporate-entity-person-with-significant-control') {
          if (psc.identification) {
            pscInfo.identification = psc.identification;
          }

          // Try to trace the corporate owner
          let companyNumberToTrace = psc.identification?.registration_number;

          // If no registration number, try to find the company by name
          if (!companyNumberToTrace && psc.name) {
            try {
              const searchResults = await fetchFromCompaniesHouse(
                `/search/companies?q=${encodeURIComponent(psc.name)}&items_per_page=5`
              );
              // Look for an exact or close match
              if (searchResults.items && searchResults.items.length > 0) {
                const exactMatch = searchResults.items.find(
                  item => item.title.toLowerCase() === psc.name.toLowerCase()
                );
                if (exactMatch) {
                  companyNumberToTrace = exactMatch.company_number;
                  console.log(`Found company number ${companyNumberToTrace} for "${psc.name}" via search`);
                }
              }
            } catch (e) {
              console.log(`Could not search for company "${psc.name}": ${e.message}`);
            }
          }

          if (companyNumberToTrace) {
            // Format the company number (pad with zeros if needed for UK companies)
            const formattedNumber = companyNumberToTrace.toString().padStart(8, '0');
            try {
              pscInfo.parent_chain = await traceOwnershipChain(formattedNumber, depth + 1, visited);
            } catch (e) {
              // Company not found in UK registry - that's OK, it might be foreign
              console.log(`Could not trace ${companyNumberToTrace}: ${e.message}`);
            }
          }
        }

        result.pscs.push(pscInfo);
      }
    }

    return result;
  } catch (error) {
    console.error(`Error tracing company ${companyNumber}:`, error.message);
    return {
      company_number: companyNumber,
      error: error.message,
      depth: depth
    };
  }
}

// Get ownership chain
app.get('/api/company/:companyNumber/ownership-chain', async (req, res) => {
  try {
    const chain = await traceOwnershipChain(req.params.companyNumber);
    res.json(chain);
  } catch (error) {
    console.error('Ownership chain error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Cross-directorship Search API Endpoints
// ============================================

// Search for officers by name
app.get('/api/officers/search', async (req, res) => {
  try {
    const { q, items_per_page = 50 } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    const data = await fetchFromCompaniesHouse(
      `/search/officers?q=${encodeURIComponent(q)}&items_per_page=${items_per_page}`
    );
    res.json(data);
  } catch (error) {
    console.error('Officer search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get officer appointments by officer ID
app.get('/api/officers/:officerId/appointments', async (req, res) => {
  try {
    const { officerId } = req.params;
    const maxAppointments = 500;
    const pageSize = 50;
    let allItems = [];
    let startIndex = 0;
    let totalResults = 0;

    // Fetch first page
    const firstPage = await fetchFromCompaniesHouse(
      `/officers/${officerId}/appointments?items_per_page=${pageSize}&start_index=0`
    );

    allItems = firstPage.items || [];
    totalResults = firstPage.total_results || allItems.length;

    // Fetch remaining pages if needed
    while (allItems.length < totalResults && allItems.length < maxAppointments) {
      startIndex += pageSize;
      const nextPage = await fetchFromCompaniesHouse(
        `/officers/${officerId}/appointments?items_per_page=${pageSize}&start_index=${startIndex}`
      );
      if (!nextPage.items || nextPage.items.length === 0) break;
      allItems = allItems.concat(nextPage.items);
    }

    res.json({
      ...firstPage,
      items: allItems.slice(0, maxAppointments),
      items_per_page: allItems.length,
      total_results: totalResults
    });
  } catch (error) {
    console.error('Officer appointments error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Find related officers by DOB match (for cross-directorship stitching)
app.get('/api/officers/find-related', async (req, res) => {
  try {
    const { name, dobMonth, dobYear } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Normalize a string: lowercase, remove/standardize special characters
    const normalize = (str) => {
      return str.toLowerCase()
        .replace(/[''`]/g, "'")  // Standardize apostrophes
        .replace(/[""]/g, '"')   // Standardize quotes
        .trim();
    };

    // Extract surname (last word) and first name for matching
    const nameParts = name.trim().split(/\s+/);
    const surname = normalize(nameParts[nameParts.length - 1]);
    const firstName = normalize(nameParts[0]);

    // Helper function to check if an officer name matches (first name + surname, ignoring middle names)
    const nameMatches = (officerName) => {
      if (!officerName) return false;
      const normalized = normalize(officerName);

      // Handle "SURNAME, FirstName" format
      if (normalized.includes(',')) {
        const [surnamePartRaw, ...rest] = normalized.split(',');
        const surnamePart = surnamePartRaw.trim();
        const firstPart = rest.join(',').trim().split(/\s+/)[0]; // First word after comma
        return firstPart === firstName && surnamePart === surname;
      }

      // Handle "FirstName MiddleName Surname" format
      const parts = normalized.split(/\s+/);
      if (parts.length < 2) return false;
      const officerFirst = parts[0];
      const officerSurname = parts[parts.length - 1];
      return officerFirst === firstName && officerSurname === surname;
    };

    // Create search queries - try multiple variations for better API matching
    const baseQuery = `${firstName} ${surname}`;
    const surnameFirst = `${surname} ${firstName}`;
    const searchQueries = new Set([
      baseQuery,                              // "paul o'donnell"
      baseQuery.replace(/'/g, ''),            // "paul odonnell"
      surnameFirst,                           // "o'donnell paul"
      surnameFirst.replace(/'/g, ''),         // "odonnell paul"
    ]);

    const allResults = [];
    const seenOfficerIds = new Set();

    // Search each query variation
    for (const searchQuery of searchQueries) {
      let startIndex = 0;
      const itemsPerPage = 100;
      const maxPages = 3; // Limit per query to avoid too many API calls

      for (let page = 0; page < maxPages; page++) {
        try {
          const data = await fetchFromCompaniesHouse(
            `/search/officers?q=${encodeURIComponent(searchQuery)}&items_per_page=${itemsPerPage}&start_index=${startIndex}`
          );

          if (!data.items || data.items.length === 0) break;

          for (const officer of data.items) {
            // Extract officer ID from links
            const officerId = officer.links?.self?.replace('/officers/', '').replace('/appointments', '') || null;

            // Skip if we've already seen this officer
            if (officerId && seenOfficerIds.has(officerId)) continue;
            if (officerId) seenOfficerIds.add(officerId);

            // Check if first name and surname match (ignore middle names)
            if (!nameMatches(officer.title)) continue;

            // Filter by DOB if provided
            if (dobMonth && dobYear) {
              const dob = officer.date_of_birth;
              if (!dob || dob.month !== parseInt(dobMonth) || dob.year !== parseInt(dobYear)) {
                continue;
              }
            }

            allResults.push({
              ...officer,
              officer_id: officerId
            });
          }

          // Check if we've reached the end
          startIndex += itemsPerPage;
          if (startIndex >= (data.total_results || 0)) break;
        } catch (e) {
          console.log(`Search failed: ${e.message}`);
          break;
        }
      }
    }

    res.json({
      items: allResults,
      total_results: allResults.length,
      search_name: { firstName, surname }
    });
  } catch (error) {
    console.error('Find related officers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Company Timeline - aggregate key events
app.get('/api/company/:companyNumber/timeline', async (req, res) => {
  try {
    const { companyNumber } = req.params;
    const events = [];

    // Fetch all data sources in parallel
    const [companyData, filingHistory, officers, charges, pscs] = await Promise.all([
      fetchFromCompaniesHouse(`/company/${companyNumber}`).catch(() => null),
      fetchFromCompaniesHouse(`/company/${companyNumber}/filing-history?items_per_page=100`).catch(() => ({ items: [] })),
      fetchFromCompaniesHouse(`/company/${companyNumber}/officers?items_per_page=100`).catch(() => ({ items: [] })),
      fetchFromCompaniesHouse(`/company/${companyNumber}/charges`).catch(() => ({ items: [] })),
      fetchFromCompaniesHouse(`/company/${companyNumber}/persons-with-significant-control`).catch(() => ({ items: [] }))
    ]);

    if (!companyData) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Company incorporation
    if (companyData.date_of_creation) {
      events.push({
        date: companyData.date_of_creation,
        type: 'incorporation',
        category: 'Company',
        title: 'Company Incorporated',
        description: `${companyData.company_name} incorporated as ${companyData.type?.replace(/-/g, ' ') || 'company'}`
      });
    }

    // Company status changes (dissolution, restoration, etc.)
    if (companyData.date_of_cessation) {
      events.push({
        date: companyData.date_of_cessation,
        type: 'status_change',
        category: 'Company',
        title: 'Company Dissolved',
        description: `Company status: ${companyData.company_status?.replace(/-/g, ' ') || 'dissolved'}`
      });
    }

    // Filing history events
    for (const filing of (filingHistory.items || [])) {
      const filingType = filing.type || '';
      const description = filing.description || '';

      let category = 'Filing';
      let title = filing.description || 'Filing';
      let skip = false;

      // Categorize filings - be specific to avoid catching ancillary documents
      if (description.includes('accounts-with-accounts-type') ||
          description.includes('full-accounts') ||
          description.includes('small-company-accounts') ||
          description.includes('micro-entity-accounts') ||
          description.includes('dormant-accounts') ||
          description.includes('group-accounts') ||
          description.includes('unaudited-accounts')) {
        // Actual accounts filings only
        category = 'Accounts';
        title = 'Accounts Filed';
        if (filing.description_values?.made_up_date) {
          title += ` (to ${filing.description_values.made_up_date})`;
        }
      } else if (description.includes('change-account-reference-date') || description.includes('accounting-reference')) {
        category = 'Accounts';
        title = 'Accounting Reference Date Change';
      } else if (description.includes('confirmation-statement')) {
        category = 'Confirmation';
        title = 'Confirmation Statement Filed';
        if (filing.description_values?.confirmation_statement_date) {
          title += ` (${filing.description_values.confirmation_statement_date})`;
        }
      } else if (description.includes('annual-return')) {
        category = 'Confirmation';
        title = 'Annual Return Filed';
      } else if (description.includes('incorporation')) {
        skip = true; // Skip, we already have incorporation event
      } else if (description.includes('officer') || description.includes('director') || description.includes('secretary') || description.includes('appoint') || description.includes('terminat') || description.includes('resign')) {
        skip = true; // Skip officer filings - we get this from officers endpoint
      } else if (description.includes('registered-office') || description.includes('sail-address')) {
        category = 'Address';
        title = 'Registered Office Change';
      } else if (description.includes('statement-of-capital')) {
        category = 'Capital';
        title = 'Statement of Capital';
        if (filing.description_values?.capital?.[0]?.figure) {
          title = `Capital: £${filing.description_values.capital[0].figure}`;
        }
      } else if (description.includes('resolution') && (description.includes('capital') || description.includes('share'))) {
        category = 'Capital';
        title = 'Capital Resolution';
      } else if (description.includes('charge') || description.includes('mortgage')) {
        skip = true; // Skip charge filings - we get this from charges endpoint
      } else if (description.includes('liquidation') || description.includes('insolvency') || description.includes('administration') || description.includes('winding-up') || description.includes('receiver') || description.includes('voluntary-arrangement')) {
        category = 'Insolvency';
        title = formatFilingDescription(description, filing.description_values);
      } else if (description.includes('change-of-name')) {
        category = 'Company';
        title = 'Name Change';
        if (filing.description_values?.new_company_name) {
          title = `Name changed to ${filing.description_values.new_company_name}`;
        }
      } else if (description.includes('psc') || description.includes('persons-with-significant-control')) {
        skip = true; // Skip PSC filings - we get this from PSC endpoint
      } else if (description.includes('memorandum') || description.includes('articles') || description.includes('constitution')) {
        category = 'Company';
        title = 'Articles/Constitution Change';
      } else {
        // Skip generic/unclear filings
        skip = true;
      }

      if (skip) continue;

      // Build document link if available
      let documentUrl = null;
      if (filing.links?.document_metadata) {
        documentUrl = `https://find-and-update.company-information.service.gov.uk${filing.links.self || ''}/document`;
      }

      events.push({
        date: filing.date,
        type: 'filing',
        category,
        title,
        documentUrl,
        filingType: filing.type
      });
    }

    // Officer appointments and resignations
    for (const officer of (officers.items || [])) {
      const name = officer.name || 'Unknown';
      const role = officer.officer_role?.replace(/-/g, ' ') || 'officer';

      if (officer.appointed_on) {
        events.push({
          date: officer.appointed_on,
          type: 'officer_appointed',
          category: 'Officers',
          title: `${role.charAt(0).toUpperCase() + role.slice(1)} Appointed`,
          description: name
        });
      }

      if (officer.resigned_on) {
        events.push({
          date: officer.resigned_on,
          type: 'officer_resigned',
          category: 'Officers',
          title: `${role.charAt(0).toUpperCase() + role.slice(1)} Resigned`,
          description: name
        });
      }
    }

    // Charges
    for (const charge of (charges.items || [])) {
      if (charge.created_on) {
        events.push({
          date: charge.created_on,
          type: 'charge_created',
          category: 'Charges',
          title: 'Charge Created',
          description: charge.persons_entitled?.[0]?.name || charge.classification?.description || 'Security registered'
        });
      }
      if (charge.satisfied_on) {
        events.push({
          date: charge.satisfied_on,
          type: 'charge_satisfied',
          category: 'Charges',
          title: 'Charge Satisfied',
          description: charge.persons_entitled?.[0]?.name || 'Security released'
        });
      }
    }

    // PSC notifications
    for (const psc of (pscs.items || [])) {
      if (psc.notified_on) {
        const pscName = psc.name || psc.name_elements?.forename + ' ' + psc.name_elements?.surname || 'PSC';
        events.push({
          date: psc.notified_on,
          type: 'psc_notified',
          category: 'PSC',
          title: 'PSC Notified',
          description: pscName
        });
      }
      if (psc.ceased_on) {
        const pscName = psc.name || 'PSC';
        events.push({
          date: psc.ceased_on,
          type: 'psc_ceased',
          category: 'PSC',
          title: 'PSC Ceased',
          description: pscName
        });
      }
    }

    // Sort by date descending (most recent first)
    events.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    res.json({
      company: {
        name: companyData.company_name,
        number: companyData.company_number,
        status: companyData.company_status,
        type: companyData.type
      },
      events,
      total_events: events.length
    });
  } catch (error) {
    console.error('Timeline error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Helper to format filing descriptions
function formatFilingDescription(description, values) {
  if (!description) return 'Filing';
  let result = description.replace(/-/g, ' ');
  // Replace placeholders with values
  if (values) {
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(`{${key}}`, value);
    }
  }
  // Capitalize first letter
  return result.charAt(0).toUpperCase() + result.slice(1);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiKeyConfigured: !!process.env.COMPANIES_HOUSE_API_KEY
  });
});

// Serve frontend for all other routes (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.COMPANIES_HOUSE_API_KEY}`);
});
