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
