import { useState, useRef } from 'react'
import html2canvas from 'html2canvas'

// API helper functions
const api = {
  search: async (query) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
    if (!res.ok) throw new Error('Search failed')
    return res.json()
  },
  getCompany: async (companyNumber) => {
    const res = await fetch(`/api/company/${companyNumber}`)
    if (!res.ok) throw new Error('Failed to fetch company')
    return res.json()
  },
  getOfficers: async (companyNumber) => {
    const res = await fetch(`/api/company/${companyNumber}/officers`)
    if (!res.ok) throw new Error('Failed to fetch officers')
    return res.json()
  },
  getPSCs: async (companyNumber) => {
    const res = await fetch(`/api/company/${companyNumber}/pscs`)
    if (!res.ok) throw new Error('Failed to fetch PSCs')
    return res.json()
  },
  getOwnershipChain: async (companyNumber) => {
    const res = await fetch(`/api/company/${companyNumber}/ownership-chain`)
    if (!res.ok) throw new Error('Failed to fetch ownership chain')
    return res.json()
  }
}

// Format address helper
function formatAddress(address) {
  if (!address) return 'N/A'
  const parts = [
    address.premises,
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country
  ].filter(Boolean)
  return parts.join(', ') || 'N/A'
}

// Format natures of control
function formatNatureOfControl(nature) {
  return nature
    .replace(/-/g, ' ')
    .replace(/ownership of shares/i, 'Owns')
    .replace(/voting rights/i, 'Voting rights')
    .replace(/right to appoint and remove directors/i, 'Can appoint/remove directors')
    .replace(/significant influence or control/i, 'Significant influence/control')
    .replace(/percent/i, '%')
}

// CSV Helper functions
function escapeCSV(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function flattenOwnershipChain(node, path = [], results = []) {
  if (!node || node.circular_reference) return results

  const currentPath = [...path, node.company_name || node.company_number]

  if (node.pscs) {
    for (const psc of node.pscs) {
      if (psc.kind?.includes('corporate-entity') && psc.parent_chain) {
        flattenOwnershipChain(psc.parent_chain, currentPath, results)
      } else {
        // This is an ultimate beneficial owner (individual or non-UK corporate)
        results.push({
          chain: [...currentPath, psc.name], // Keep as array for separate cells
          ubo_name: psc.name,
          ubo_type: psc.kind?.replace(/-/g, ' ').replace('person with significant control', 'PSC') || 'Unknown',
          natures_of_control: (psc.natures_of_control || []).join('; ')
        })
      }
    }
  }

  return results
}

function generateCSV(companyData, officers, pscs, ownershipChain) {
  const lines = []

  // Company Information Section
  lines.push('COMPANY INFORMATION')
  lines.push('Field,Value')
  lines.push(`Company Name,${escapeCSV(companyData?.company_name)}`)
  lines.push(`Company Number,${escapeCSV(companyData?.company_number)}`)
  lines.push(`Status,${escapeCSV(companyData?.company_status)}`)
  lines.push(`Type,${escapeCSV(companyData?.type)}`)
  lines.push(`Incorporated,${escapeCSV(companyData?.date_of_creation)}`)
  if (companyData?.date_of_cessation) {
    lines.push(`Dissolved,${escapeCSV(companyData?.date_of_cessation)}`)
  }
  lines.push(`Registered Address,${escapeCSV(formatAddress(companyData?.registered_office_address))}`)
  if (companyData?.sic_codes?.length) {
    lines.push(`SIC Codes,${escapeCSV(companyData.sic_codes.join(', '))}`)
  }
  lines.push('')

  // Officers Section
  lines.push('OFFICERS')
  lines.push('Name,Role,Appointed,Nationality,Occupation,Address')
  const activeOfficers = (officers || []).filter(o => !o.resigned_on)
  for (const officer of activeOfficers) {
    lines.push([
      escapeCSV(officer.name),
      escapeCSV(officer.officer_role?.replace(/-/g, ' ')),
      escapeCSV(officer.appointed_on),
      escapeCSV(officer.nationality),
      escapeCSV(officer.occupation),
      escapeCSV(formatAddress(officer.address))
    ].join(','))
  }
  lines.push('')

  // PSC Section
  lines.push('PERSONS WITH SIGNIFICANT CONTROL')
  lines.push('Name,Type,Nature of Control,Nationality,Country,Registration Number,Place Registered,Address')
  const activePSCs = (pscs || []).filter(p => !p.ceased_on)
  for (const psc of activePSCs) {
    lines.push([
      escapeCSV(psc.name),
      escapeCSV(psc.kind?.replace(/-/g, ' ').replace('person with significant control', 'PSC')),
      escapeCSV((psc.natures_of_control || []).map(n => formatNatureOfControl(n)).join('; ')),
      escapeCSV(psc.nationality),
      escapeCSV(psc.country_of_residence),
      escapeCSV(psc.identification?.registration_number),
      escapeCSV(psc.identification?.place_registered),
      escapeCSV(formatAddress(psc.address))
    ].join(','))
  }
  lines.push('')

  // Ownership Chain Section (if available)
  if (ownershipChain) {
    lines.push('ULTIMATE BENEFICIAL OWNERSHIP CHAIN')
    const flatChain = flattenOwnershipChain(ownershipChain)

    // Find the maximum chain length to create dynamic headers
    const maxChainLength = Math.max(...flatChain.map(row => row.chain.length), 0)

    // Create headers: Level 1 (Target), Level 2, Level 3, ..., UBO Type, Nature of Control
    const headers = []
    for (let i = 1; i <= maxChainLength; i++) {
      if (i === 1) {
        headers.push('Level 1 (Target Company)')
      } else if (i === maxChainLength) {
        headers.push(`Level ${i} (UBO)`)
      } else {
        headers.push(`Level ${i}`)
      }
    }
    headers.push('UBO Type', 'Nature of Control')
    lines.push(headers.join(','))

    // Output each chain with entities in separate cells
    for (const row of flatChain) {
      const cells = []
      // Add each entity in the chain to its own cell
      for (let i = 0; i < maxChainLength; i++) {
        cells.push(escapeCSV(row.chain[i] || ''))
      }
      cells.push(escapeCSV(row.ubo_type))
      cells.push(escapeCSV(row.natures_of_control))
      lines.push(cells.join(','))
    }
  }

  return lines.join('\n')
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

// Search Results Component
function SearchResults({ results, onSelect, loading }) {
  if (loading) {
    return (
      <div className="mt-4 p-8 text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent"></div>
        <p className="mt-2 text-gray-600">Searching...</p>
      </div>
    )
  }

  if (!results || results.length === 0) {
    return null
  }

  return (
    <div className="mt-4 bg-white rounded-lg shadow-md overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b">
        <h3 className="font-semibold text-gray-700">Search Results ({results.length})</h3>
      </div>
      <ul className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
        {results.map((company) => (
          <li
            key={company.company_number}
            onClick={() => onSelect(company.company_number)}
            className="px-4 py-3 hover:bg-blue-50 cursor-pointer transition-colors"
          >
            <div className="flex justify-between items-start">
              <div>
                <p className="font-medium text-gray-900">{company.title}</p>
                <p className="text-sm text-gray-500">{company.company_number}</p>
                <p className="text-sm text-gray-500">{formatAddress(company.address)}</p>
              </div>
              <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                company.company_status === 'active'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-red-100 text-red-800'
              }`}>
                {company.company_status}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Company Profile Component
function CompanyProfile({ company }) {
  if (!company) return null

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
        <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
        </svg>
        Company Information
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-gray-500">Company Name</label>
          <p className="text-gray-900 font-semibold">{company.company_name}</p>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-500">Company Number</label>
          <p className="text-gray-900 font-mono">{company.company_number}</p>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-500">Status</label>
          <p className={`inline-flex px-2 py-1 text-sm font-medium rounded-full ${
            company.company_status === 'active'
              ? 'bg-green-100 text-green-800'
              : 'bg-red-100 text-red-800'
          }`}>
            {company.company_status?.toUpperCase()}
          </p>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-500">Company Type</label>
          <p className="text-gray-900">{company.type}</p>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-500">Incorporated</label>
          <p className="text-gray-900">{company.date_of_creation}</p>
        </div>
        {company.date_of_cessation && (
          <div>
            <label className="text-sm font-medium text-gray-500">Dissolved</label>
            <p className="text-gray-900">{company.date_of_cessation}</p>
          </div>
        )}
        <div className="md:col-span-2">
          <label className="text-sm font-medium text-gray-500">Registered Address</label>
          <p className="text-gray-900">{formatAddress(company.registered_office_address)}</p>
        </div>
        {company.sic_codes && company.sic_codes.length > 0 && (
          <div className="md:col-span-2">
            <label className="text-sm font-medium text-gray-500">SIC Codes</label>
            <p className="text-gray-900">{company.sic_codes.join(', ')}</p>
          </div>
        )}
      </div>

      <div className="mt-4 pt-4 border-t">
        <a
          href={`https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1"
        >
          View on Companies House
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    </div>
  )
}

// Officers Component
function Officers({ officers }) {
  if (!officers || officers.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Officers</h2>
        <p className="text-gray-500">No officers found.</p>
      </div>
    )
  }

  // Filter active officers (no resigned_on date)
  const activeOfficers = officers.filter(o => !o.resigned_on)
  const directors = activeOfficers.filter(o => o.officer_role?.includes('director'))
  const secretaries = activeOfficers.filter(o => o.officer_role?.includes('secretary'))
  const others = activeOfficers.filter(o =>
    !o.officer_role?.includes('director') && !o.officer_role?.includes('secretary')
  )

  const OfficerCard = ({ officer }) => (
    <div className="bg-gray-50 rounded-lg p-4">
      <p className="font-semibold text-gray-900">{officer.name}</p>
      <p className="text-sm text-gray-600 capitalize">{officer.officer_role?.replace(/-/g, ' ')}</p>
      {officer.appointed_on && (
        <p className="text-sm text-gray-500">Appointed: {officer.appointed_on}</p>
      )}
      {officer.nationality && (
        <p className="text-sm text-gray-500">Nationality: {officer.nationality}</p>
      )}
      {officer.occupation && (
        <p className="text-sm text-gray-500">Occupation: {officer.occupation}</p>
      )}
      <p className="text-sm text-gray-500 mt-1">{formatAddress(officer.address)}</p>
    </div>
  )

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
        <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        Officers ({activeOfficers.length} active)
      </h2>

      {directors.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-3">Directors ({directors.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {directors.map((officer, idx) => (
              <OfficerCard key={idx} officer={officer} />
            ))}
          </div>
        </div>
      )}

      {secretaries.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-3">Secretaries ({secretaries.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {secretaries.map((officer, idx) => (
              <OfficerCard key={idx} officer={officer} />
            ))}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-gray-800 mb-3">Other Officers ({others.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {others.map((officer, idx) => (
              <OfficerCard key={idx} officer={officer} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// PSC Component
function PersonsWithSignificantControl({ pscs }) {
  if (!pscs || pscs.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Persons with Significant Control</h2>
        <p className="text-gray-500">No PSC information found.</p>
      </div>
    )
  }

  // Filter active PSCs
  const activePSCs = pscs.filter(psc => !psc.ceased_on)
  const individuals = activePSCs.filter(psc => psc.kind?.includes('individual'))
  const corporateEntities = activePSCs.filter(psc => psc.kind?.includes('corporate-entity'))
  const legalPersons = activePSCs.filter(psc => psc.kind?.includes('legal-person'))

  const PSCCard = ({ psc }) => (
    <div className={`rounded-lg p-4 ${
      psc.kind?.includes('corporate-entity') ? 'bg-purple-50 border border-purple-200' : 'bg-gray-50'
    }`}>
      <div className="flex items-start justify-between">
        <p className="font-semibold text-gray-900">{psc.name}</p>
        {psc.kind?.includes('corporate-entity') && (
          <span className="px-2 py-1 text-xs font-medium bg-purple-200 text-purple-800 rounded-full">
            Corporate
          </span>
        )}
      </div>

      {psc.identification && (
        <div className="mt-2 text-sm text-gray-600">
          {psc.identification.registration_number && (
            <p>Registration: {psc.identification.registration_number}</p>
          )}
          {psc.identification.place_registered && (
            <p>Registered at: {psc.identification.place_registered}</p>
          )}
          {psc.identification.legal_form && (
            <p>Legal form: {psc.identification.legal_form}</p>
          )}
        </div>
      )}

      {psc.natures_of_control && psc.natures_of_control.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-gray-700 mb-1">Nature of Control:</p>
          <ul className="text-sm text-gray-600 space-y-1">
            {psc.natures_of_control.map((nature, idx) => (
              <li key={idx} className="flex items-center gap-1">
                <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                {formatNatureOfControl(nature)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {psc.date_of_birth && (
        <p className="text-sm text-gray-500 mt-2">
          DOB: {psc.date_of_birth.month}/{psc.date_of_birth.year}
        </p>
      )}
      {psc.nationality && (
        <p className="text-sm text-gray-500">Nationality: {psc.nationality}</p>
      )}
      {psc.country_of_residence && (
        <p className="text-sm text-gray-500">Country: {psc.country_of_residence}</p>
      )}
      <p className="text-sm text-gray-500 mt-1">{formatAddress(psc.address)}</p>
      {psc.notified_on && (
        <p className="text-sm text-gray-400 mt-2">Notified: {psc.notified_on}</p>
      )}
    </div>
  )

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
        <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
        Persons with Significant Control ({activePSCs.length})
      </h2>

      {individuals.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-3">Individuals ({individuals.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {individuals.map((psc, idx) => (
              <PSCCard key={idx} psc={psc} />
            ))}
          </div>
        </div>
      )}

      {corporateEntities.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-3">Corporate Entities ({corporateEntities.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {corporateEntities.map((psc, idx) => (
              <PSCCard key={idx} psc={psc} />
            ))}
          </div>
        </div>
      )}

      {legalPersons.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-gray-800 mb-3">Legal Persons ({legalPersons.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {legalPersons.map((psc, idx) => (
              <PSCCard key={idx} psc={psc} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Ownership Chain Node Component
function OwnershipChainNode({ node, isRoot = false }) {
  if (!node) return null

  const hasError = node.error
  const hasPSCs = node.pscs && node.pscs.length > 0

  return (
    <div className={`relative ${!isRoot ? 'ml-8 mt-4' : ''}`}>
      {!isRoot && (
        <div className="absolute -left-6 top-0 h-full">
          <div className="absolute top-6 left-0 w-6 border-t-2 border-gray-300"></div>
          <div className="absolute top-0 left-0 h-6 border-l-2 border-gray-300"></div>
        </div>
      )}

      <div className={`rounded-lg p-4 border-2 ${
        isRoot ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white'
      } ${hasError ? 'border-red-300 bg-red-50' : ''}`}>
        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${
            isRoot ? 'bg-blue-500' : hasError ? 'bg-red-500' : 'bg-green-500'
          }`}></div>
          <p className="font-semibold text-gray-900">
            {node.company_name || node.company_number}
          </p>
        </div>
        <p className="text-sm text-gray-600 font-mono ml-5">{node.company_number}</p>
        {node.company_status && (
          <p className={`text-sm ml-5 ${
            node.company_status === 'active' ? 'text-green-600' : 'text-red-600'
          }`}>
            Status: {node.company_status}
          </p>
        )}
        {hasError && (
          <p className="text-sm text-red-600 ml-5">Error: {node.error}</p>
        )}
      </div>

      {hasPSCs && (
        <div className="mt-2">
          {node.pscs.map((psc, idx) => (
            <div key={idx} className="relative ml-8 mt-4">
              <div className="absolute -left-6 top-0 h-full">
                <div className="absolute top-6 left-0 w-6 border-t-2 border-purple-300"></div>
                <div className="absolute top-0 left-0 h-6 border-l-2 border-purple-300"></div>
              </div>

              <div className={`rounded-lg p-3 border-2 ${
                psc.kind?.includes('corporate-entity')
                  ? 'border-purple-400 bg-purple-50'
                  : 'border-green-400 bg-green-50'
              }`}>
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${
                    psc.kind?.includes('corporate-entity') ? 'bg-purple-500' : 'bg-green-500'
                  }`}></div>
                  <p className="font-semibold text-gray-900">{psc.name}</p>
                </div>
                <p className="text-xs text-gray-600 ml-5 capitalize">
                  {psc.kind?.replace(/-/g, ' ').replace('person with significant control', 'PSC')}
                </p>
                {psc.natures_of_control && psc.natures_of_control.length > 0 && (
                  <div className="ml-5 mt-1">
                    {psc.natures_of_control.slice(0, 2).map((nature, nidx) => (
                      <span key={nidx} className="text-xs text-gray-500 block">
                        {formatNatureOfControl(nature)}
                      </span>
                    ))}
                  </div>
                )}
                {psc.identification?.registration_number && (
                  <p className="text-xs text-purple-600 ml-5 font-mono">
                    Reg: {psc.identification.registration_number}
                  </p>
                )}
              </div>

              {/* Recursively render parent chain for corporate entities */}
              {psc.parent_chain && (
                <OwnershipChainNode node={psc.parent_chain} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Ownership Chain Component
function OwnershipChain({ chain, loading, companyName }) {
  const diagramRef = useRef(null)

  const downloadDiagram = async () => {
    if (!diagramRef.current) return

    try {
      const canvas = await html2canvas(diagramRef.current, {
        backgroundColor: '#ffffff',
        scale: 2, // Higher resolution
        logging: false,
        useCORS: true
      })

      const link = document.createElement('a')
      link.download = `${companyName || 'ownership-chain'}_diagram_${new Date().toISOString().split('T')[0]}.png`.replace(/[^a-zA-Z0-9_.-]/g, '_')
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch (error) {
      console.error('Failed to generate diagram:', error)
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6 mb-6">
        <h2 className="text-xl font-bold text-gray-900 mb-4">Ownership Chain</h2>
        <div className="flex items-center justify-center p-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-purple-500 border-t-transparent"></div>
          <p className="ml-3 text-gray-600">Tracing ownership chain...</p>
        </div>
      </div>
    )
  }

  if (!chain) return null

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Ultimate Beneficial Ownership Chain
        </h2>
        <button
          onClick={downloadDiagram}
          className="px-3 py-1.5 text-sm font-medium text-purple-700 bg-purple-100 hover:bg-purple-200 rounded-lg transition-colors flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          Download Diagram
        </button>
      </div>

      <div ref={diagramRef} className="bg-white">
        <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
          <p>This diagram traces corporate ownership through UK-registered companies to identify ultimate beneficial owners.</p>
          <div className="flex flex-wrap gap-4 mt-2">
            <span className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-blue-500"></div> Target Company
            </span>
            <span className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-purple-500"></div> Corporate PSC
            </span>
            <span className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-green-500"></div> Individual/Legal Person
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-max p-4">
            <OwnershipChainNode node={chain} isRoot={true} />
          </div>
        </div>
      </div>
    </div>
  )
}

// Main App Component
function App() {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedCompany, setSelectedCompany] = useState(null)
  const [companyData, setCompanyData] = useState(null)
  const [officers, setOfficers] = useState(null)
  const [pscs, setPSCs] = useState(null)
  const [ownershipChain, setOwnershipChain] = useState(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!searchQuery.trim()) return

    setSearchLoading(true)
    setError(null)
    setSearchResults(null)
    setSelectedCompany(null)
    setCompanyData(null)
    setOfficers(null)
    setPSCs(null)
    setOwnershipChain(null)

    try {
      const data = await api.search(searchQuery)
      setSearchResults(data.items || [])
    } catch (err) {
      setError('Search failed. Please check if the backend is running and API key is configured.')
      console.error(err)
    } finally {
      setSearchLoading(false)
    }
  }

  const handleSelectCompany = async (companyNumber) => {
    setSelectedCompany(companyNumber)
    setLoading(true)
    setError(null)
    setSearchResults(null)
    setOwnershipChain(null)

    try {
      // Fetch company data, officers, and PSCs in parallel
      const [company, officersData, pscsData] = await Promise.all([
        api.getCompany(companyNumber),
        api.getOfficers(companyNumber).catch(() => ({ items: [] })),
        api.getPSCs(companyNumber).catch(() => ({ items: [] }))
      ])

      setCompanyData(company)
      setOfficers(officersData.items || [])
      setPSCs(pscsData.items || [])

      // Check if there are corporate PSCs to trace
      const hasCorporatePSCs = (pscsData.items || []).some(
        psc => psc.kind?.includes('corporate-entity') && !psc.ceased_on
      )

      if (hasCorporatePSCs) {
        setChainLoading(true)
        try {
          const chain = await api.getOwnershipChain(companyNumber)
          setOwnershipChain(chain)
        } catch (err) {
          console.error('Failed to fetch ownership chain:', err)
        } finally {
          setChainLoading(false)
        }
      }
    } catch (err) {
      setError('Failed to fetch company data. Please try again.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const handleReset = () => {
    setSearchQuery('')
    setSearchResults(null)
    setSelectedCompany(null)
    setCompanyData(null)
    setOfficers(null)
    setPSCs(null)
    setOwnershipChain(null)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600 p-2 rounded-lg">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Companies House Extractor</h1>
                <p className="text-sm text-gray-500">Extract company information, officers, and ownership data</p>
              </div>
            </div>
            {selectedCompany && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const csv = generateCSV(companyData, officers, pscs, ownershipChain)
                    const filename = `${companyData?.company_name || selectedCompany}_${new Date().toISOString().split('T')[0]}.csv`
                    downloadCSV(csv, filename.replace(/[^a-zA-Z0-9_-]/g, '_'))
                  }}
                  disabled={!companyData}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download CSV
                </button>
                <button
                  onClick={handleReset}
                  className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  New Search
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Search Section */}
        {!selectedCompany && (
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-xl shadow-lg p-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Search for a Company</h2>
              <form onSubmit={handleSearch} className="space-y-4">
                <div>
                  <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-1">
                    Company name or number
                  </label>
                  <input
                    id="search"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="e.g., Apple UK Limited or 03977902"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={searchLoading || !searchQuery.trim()}
                  className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {searchLoading ? 'Searching...' : 'Search'}
                </button>
              </form>

              {error && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                  {error}
                </div>
              )}

              <SearchResults
                results={searchResults}
                onSelect={handleSelectCompany}
                loading={searchLoading}
              />
            </div>
          </div>
        )}

        {/* Company Data Section */}
        {selectedCompany && (
          <div>
            {loading ? (
              <div className="flex items-center justify-center p-12">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div>
                <p className="ml-4 text-lg text-gray-600">Loading company data...</p>
              </div>
            ) : (
              <>
                {error && (
                  <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                    {error}
                  </div>
                )}

                <CompanyProfile company={companyData} />
                <Officers officers={officers} />
                <PersonsWithSignificantControl pscs={pscs} />

                {(ownershipChain || chainLoading) && (
                  <OwnershipChain chain={ownershipChain} loading={chainLoading} companyName={companyData?.company_name} />
                )}
              </>
            )}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-gray-500">
        <p>Data sourced from Companies House. All information can be verified at{' '}
          <a
            href="https://find-and-update.company-information.service.gov.uk/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline"
          >
            Companies House
          </a>
        </p>
      </footer>
    </div>
  )
}

export default App
