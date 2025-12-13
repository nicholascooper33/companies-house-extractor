require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Companies House API base URL
const CH_API_BASE = 'https://api.company-information.service.gov.uk';

app.use(cors());
app.use(express.json());

// Helper function to make authenticated requests to Companies House API
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

// Search companies by name or number
app.get('/api/search', async (req, res) => {
  try {
    const { q, items_per_page = 20 } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const data = await fetchFromCompaniesHouse(`/search/companies?q=${encodeURIComponent(q)}&items_per_page=${items_per_page}`);
    res.json(data);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get company profile
app.get('/api/company/:companyNumber', async (req, res) => {
  try {
    const { companyNumber } = req.params;
    const data = await fetchFromCompaniesHouse(`/company/${companyNumber}`);
    res.json(data);
  } catch (error) {
    console.error('Company profile error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get company officers (directors, secretaries)
app.get('/api/company/:companyNumber/officers', async (req, res) => {
  try {
    const { companyNumber } = req.params;
    const data = await fetchFromCompaniesHouse(`/company/${companyNumber}/officers`);
    res.json(data);
  } catch (error) {
    console.error('Officers error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get persons with significant control
app.get('/api/company/:companyNumber/pscs', async (req, res) => {
  try {
    const { companyNumber } = req.params;
    const data = await fetchFromCompaniesHouse(`/company/${companyNumber}/persons-with-significant-control`);
    res.json(data);
  } catch (error) {
    console.error('PSC error:', error);
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
      pscs = await fetchFromCompaniesHouse(`/company/${companyNumber}/persons-with-significant-control`);
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
        if (psc.kind === 'corporate-entity-person-with-significant-control' && psc.identification) {
          pscInfo.identification = psc.identification;

          // Try to trace the corporate owner - attempt lookup for any company with a registration number
          const regNumber = psc.identification.registration_number;
          if (regNumber) {
            // Format the company number (pad with zeros if needed for UK companies)
            const formattedNumber = regNumber.toString().padStart(8, '0');
            try {
              pscInfo.parent_chain = await traceOwnershipChain(formattedNumber, depth + 1, visited);
            } catch (e) {
              // Company not found in UK registry - that's OK, it might be foreign
              console.log(`Could not trace ${regNumber}: ${e.message}`);
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

// Get ownership chain for a company
app.get('/api/company/:companyNumber/ownership-chain', async (req, res) => {
  try {
    const { companyNumber } = req.params;
    const chain = await traceOwnershipChain(companyNumber);
    res.json(chain);
  } catch (error) {
    console.error('Ownership chain error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiKeyConfigured: !!process.env.COMPANIES_HOUSE_API_KEY
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.COMPANIES_HOUSE_API_KEY}`);
});
