import { useState } from 'react'

// ============================================
// API Helper Functions
// ============================================
const api = {
  // Company search APIs
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
  },
  // Officer search APIs
  searchOfficers: async (query) => {
    const res = await fetch(`/api/officers/search?q=${encodeURIComponent(query)}`)
    if (!res.ok) throw new Error('Officer search failed')
    return res.json()
  },
  getOfficerAppointments: async (officerId) => {
    const res = await fetch(`/api/officers/${encodeURIComponent(officerId)}/appointments`)
    if (!res.ok) throw new Error('Failed to fetch appointments')
    return res.json()
  },
  findRelatedOfficers: async (name, dobMonth, dobYear) => {
    const params = new URLSearchParams({ name })
    if (dobMonth) params.append('dobMonth', dobMonth)
    if (dobYear) params.append('dobYear', dobYear)
    const res = await fetch(`/api/officers/find-related?${params}`)
    if (!res.ok) throw new Error('Failed to find related officers')
    return res.json()
  },
  // Timeline API
  getTimeline: async (companyNumber) => {
    const res = await fetch(`/api/company/${companyNumber}/timeline`)
    if (!res.ok) throw new Error('Failed to fetch timeline')
    return res.json()
  }
}

// ============================================
// Utility Functions
// ============================================
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

function formatNatureOfControl(nature) {
  return nature
    .replace(/-/g, ' ')
    .replace(/ownership of shares/i, 'Owns')
    .replace(/voting rights/i, 'Voting rights')
    .replace(/right to appoint and remove directors/i, 'Can appoint/remove directors')
    .replace(/significant influence or control/i, 'Significant influence/control')
    .replace(/percent/i, '%')
}

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
        results.push({
          chain: [...currentPath, psc.name],
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

  if (ownershipChain) {
    lines.push('ULTIMATE BENEFICIAL OWNERSHIP CHAIN')
    const flatChain = flattenOwnershipChain(ownershipChain)
    const maxChainLength = Math.max(...flatChain.map(row => row.chain.length), 0)
    const headers = []
    for (let i = 1; i <= maxChainLength; i++) {
      if (i === 1) headers.push('Level 1 (Target Company)')
      else if (i === maxChainLength) headers.push(`Level ${i} (UBO)`)
      else headers.push(`Level ${i}`)
    }
    headers.push('UBO Type', 'Nature of Control')
    lines.push(headers.join(','))
    for (const row of flatChain) {
      const cells = []
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

// Structure Chart SVG Generator (keeping the full implementation)
function generateStructureChartSVG(ownershipChain, companyName) {
  const BOX_WIDTH = 250
  const MIN_BOX_HEIGHT = 60
  const BOX_PADDING = 12
  const HORIZONTAL_GAP = 40
  const VERTICAL_GAP = 50
  const FONT_SIZE = 11
  const SMALL_FONT_SIZE = 10
  const LINE_HEIGHT = 14
  const CHARS_PER_LINE = 32

  const COLORS = {
    target: { fill: '#DBEAFE', stroke: '#3B82F6', text: '#1E40AF' },
    corporate: { fill: '#F3E8FF', stroke: '#A855F7', text: '#7E22CE' },
    individual: { fill: '#DCFCE7', stroke: '#22C55E', text: '#166534' },
    line: '#94A3B8'
  }

  function wrapText(text, maxCharsPerLine) {
    if (!text) return ['']
    const words = text.split(' ')
    const lines = []
    let currentLine = ''
    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxCharsPerLine) {
        currentLine += (currentLine ? ' ' : '') + word
      } else {
        if (currentLine) lines.push(currentLine)
        if (word.length > maxCharsPerLine) {
          let remaining = word
          while (remaining.length > maxCharsPerLine) {
            lines.push(remaining.substring(0, maxCharsPerLine - 1) + '-')
            remaining = remaining.substring(maxCharsPerLine - 1)
          }
          currentLine = remaining
        } else {
          currentLine = word
        }
      }
    }
    if (currentLine) lines.push(currentLine)
    return lines.length > 0 ? lines : ['']
  }

  function formatNatures(natures) {
    if (!natures || natures.length === 0) return []
    return natures.map(n =>
      n.replace(/-/g, ' ')
        .replace(/ownership of shares/i, 'Owns')
        .replace(/voting rights/i, 'Voting')
        .replace(/right to appoint and remove directors/i, 'Appoint directors')
        .replace(/significant influence or control/i, 'Significant control')
        .replace(/percent/i, '%')
    )
  }

  function calculateBoxHeight(nameLines, hasNumber, naturesCount) {
    const nameHeight = nameLines.length * LINE_HEIGHT
    const numberHeight = hasNumber ? LINE_HEIGHT : 0
    const naturesHeight = Math.min(naturesCount, 2) * (LINE_HEIGHT - 2)
    return Math.max(MIN_BOX_HEIGHT, nameHeight + numberHeight + naturesHeight + 20)
  }

  const nodeData = []

  function collectNodes(node, depth, isCompany = true) {
    if (!node) return
    const name = node.company_name || node.name || node.company_number || 'Unknown'
    const number = node.company_number || node.identification?.registration_number || ''
    const natures = node.natures_of_control || []
    const nameLines = wrapText(name, CHARS_PER_LINE)
    const height = calculateBoxHeight(nameLines, !!number, natures.length)
    nodeData.push({ depth, name, nameLines, number, natures: formatNatures(natures), type: depth === 0 ? 'target' : (isCompany ? 'corporate' : 'individual'), height, isCompany })
    if (node.pscs) {
      for (const psc of node.pscs) {
        if (psc.parent_chain) {
          collectNodes(psc.parent_chain, depth + 1, true)
        } else {
          const pscName = psc.name || 'Unknown'
          const pscNumber = psc.identification?.registration_number || ''
          const pscNatures = psc.natures_of_control || []
          const pscNameLines = wrapText(pscName, CHARS_PER_LINE)
          const pscHeight = calculateBoxHeight(pscNameLines, !!pscNumber, pscNatures.length)
          const isCorporate = psc.kind?.includes('corporate-entity')
          nodeData.push({ depth: depth + 1, name: pscName, nameLines: pscNameLines, number: pscNumber, natures: formatNatures(pscNatures), type: isCorporate ? 'corporate' : 'individual', height: pscHeight, isCompany: false })
        }
      }
    }
  }

  collectNodes(ownershipChain, 0, true)

  const maxHeightPerDepth = {}
  for (const node of nodeData) {
    if (!maxHeightPerDepth[node.depth] || node.height > maxHeightPerDepth[node.depth]) {
      maxHeightPerDepth[node.depth] = node.height
    }
  }

  const yPositionPerDepth = {}
  // Reverse the order: highest depth at top, depth 0 at bottom
  const depths = Object.keys(maxHeightPerDepth).map(Number).sort((a, b) => b - a) // Sort descending
  let currentY = BOX_PADDING + 40
  for (const depth of depths) {
    yPositionPerDepth[depth] = currentY
    currentY += maxHeightPerDepth[depth] + VERTICAL_GAP
  }

  const nodes = []
  const connections = []

  function getSubtreeWidth(node) {
    if (!node || !node.pscs || node.pscs.length === 0) return 1
    let width = 0
    for (const psc of node.pscs) {
      if (psc.parent_chain) width += getSubtreeWidth(psc.parent_chain)
      else width += 1
    }
    return Math.max(width, 1)
  }

  function layoutNode(node, depth, xOffset, parentId = null, parentX = null, parentY = null, parentHeight = 0, isCompany = true) {
    if (!node) return xOffset
    const subtreeWidth = getSubtreeWidth(node)
    const nodeWidth = subtreeWidth * (BOX_WIDTH + HORIZONTAL_GAP) - HORIZONTAL_GAP
    const x = xOffset + nodeWidth / 2
    const y = yPositionPerDepth[depth]
    const name = node.company_name || node.name || node.company_number || 'Unknown'
    const number = node.company_number || node.identification?.registration_number || ''
    const natures = node.natures_of_control || []
    const nameLines = wrapText(name, CHARS_PER_LINE)
    const height = maxHeightPerDepth[depth]
    const nodeId = nodes.length
    const nodeType = depth === 0 ? 'target' : (isCompany ? 'corporate' : 'individual')
    nodes.push({ id: nodeId, x, y, nameLines, number, type: nodeType, natures: formatNatures(natures), height })
    if (parentId !== null) {
      // Connect upward: from this node (bottom) to parent (top)
      connections.push({ from: { x, y: y + height }, to: { x: parentX, y: parentY } })
    }
    if (node.pscs && node.pscs.length > 0) {
      let childXOffset = xOffset
      for (const psc of node.pscs) {
        if (psc.parent_chain) {
          childXOffset = layoutNode(psc.parent_chain, depth + 1, childXOffset, nodeId, x, y, height, true)
        } else {
          const childSubtreeWidth = 1
          const childNodeWidth = childSubtreeWidth * (BOX_WIDTH + HORIZONTAL_GAP) - HORIZONTAL_GAP
          const childX = childXOffset + childNodeWidth / 2
          const childY = yPositionPerDepth[depth + 1]
          const childHeight = maxHeightPerDepth[depth + 1]
          const childId = nodes.length
          const isCorporate = psc.kind?.includes('corporate-entity')
          const pscName = psc.name || 'Unknown'
          const pscNumber = psc.identification?.registration_number || ''
          const pscNatures = psc.natures_of_control || []
          nodes.push({ id: childId, x: childX, y: childY, nameLines: wrapText(pscName, CHARS_PER_LINE), number: pscNumber, type: isCorporate ? 'corporate' : 'individual', natures: formatNatures(pscNatures), height: childHeight })
          // Connect upward: from parent (top edge) to child/owner (bottom edge)
          connections.push({ from: { x, y }, to: { x: childX, y: childY + childHeight } })
          childXOffset += BOX_WIDTH + HORIZONTAL_GAP
        }
      }
    }
    return xOffset + nodeWidth + HORIZONTAL_GAP
  }

  layoutNode(ownershipChain, 0, BOX_PADDING)

  const maxX = Math.max(...nodes.map(n => n.x)) + BOX_WIDTH / 2 + BOX_PADDING
  const maxY = Math.max(...nodes.map(n => n.y + n.height)) + BOX_PADDING
  const svgWidth = Math.max(maxX, 400)
  const svgHeight = maxY + 60

  function escapeXML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  }

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <defs>
    <style>
      .box-text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      .company-name { font-size: ${FONT_SIZE}px; font-weight: 600; }
      .company-number { font-size: ${SMALL_FONT_SIZE}px; font-family: monospace; }
      .control-info { font-size: ${SMALL_FONT_SIZE - 1}px; fill: #6B7280; }
      .legend-text { font-size: ${SMALL_FONT_SIZE}px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    </style>
  </defs>
  <rect width="100%" height="100%" fill="white"/>
  <text x="${svgWidth / 2}" y="25" text-anchor="middle" class="box-text" style="font-size: 14px; font-weight: bold; fill: #1F2937;">
    Ownership Structure: ${escapeXML(companyName || 'Company')}
  </text>
`

  svg += '\n  <!-- Connections -->\n'
  for (const conn of connections) {
    const midY = (conn.from.y + conn.to.y) / 2
    svg += `  <path d="M ${conn.from.x} ${conn.from.y} L ${conn.from.x} ${midY} L ${conn.to.x} ${midY} L ${conn.to.x} ${conn.to.y}" fill="none" stroke="${COLORS.line}" stroke-width="2"/>\n`
  }

  svg += '\n  <!-- Nodes -->\n'
  for (const node of nodes) {
    const colors = COLORS[node.type]
    const boxX = node.x - BOX_WIDTH / 2
    let textY = 18
    const nameTextElements = node.nameLines.map((line, i) => {
      const y = textY + (i * LINE_HEIGHT)
      return `    <text x="${BOX_WIDTH / 2}" y="${y}" text-anchor="middle" class="box-text company-name" fill="${colors.text}">${escapeXML(line)}</text>`
    }).join('\n')
    textY += node.nameLines.length * LINE_HEIGHT + 4
    const numberElement = node.number ? `    <text x="${BOX_WIDTH / 2}" y="${textY}" text-anchor="middle" class="company-number" fill="${colors.text}">${escapeXML(node.number)}</text>` : ''
    if (node.number) textY += LINE_HEIGHT
    const naturesElements = node.natures.slice(0, 2).map((nature, i) => {
      const y = textY + (i * (LINE_HEIGHT - 2))
      return `    <text x="${BOX_WIDTH / 2}" y="${y}" text-anchor="middle" class="control-info">${escapeXML(nature)}</text>`
    }).join('\n')
    svg += `  <g transform="translate(${boxX}, ${node.y})">
    <rect width="${BOX_WIDTH}" height="${node.height}" rx="8" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>
${nameTextElements}
${numberElement}
${naturesElements}
  </g>\n`
  }

  const legendY = maxY + 20
  svg += `
  <!-- Legend -->
  <g transform="translate(${BOX_PADDING}, ${legendY})">
    <rect width="16" height="16" rx="3" fill="${COLORS.target.fill}" stroke="${COLORS.target.stroke}" stroke-width="1.5"/>
    <text x="22" y="12" class="legend-text" fill="#374151">Target Company</text>
    <rect x="140" width="16" height="16" rx="3" fill="${COLORS.corporate.fill}" stroke="${COLORS.corporate.stroke}" stroke-width="1.5"/>
    <text x="162" y="12" class="legend-text" fill="#374151">Corporate Entity</text>
    <rect x="290" width="16" height="16" rx="3" fill="${COLORS.individual.fill}" stroke="${COLORS.individual.stroke}" stroke-width="1.5"/>
    <text x="312" y="12" class="legend-text" fill="#374151">Individual / UBO</text>
  </g>
`
  svg += '</svg>'
  return svg
}

function downloadSVG(content, filename) {
  const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

// ============================================
// Module Selection Component
// ============================================
function ModuleSelector({ onSelectModule }) {
  const modules = [
    {
      id: 'psc-extractor',
      name: 'PSC Extractor',
      description: 'Search for companies and extract ownership information, directors, and persons with significant control. Trace corporate ownership chains to identify ultimate beneficial owners.',
      icon: (
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
      color: 'blue'
    },
    {
      id: 'cross-directorship',
      name: 'Cross-directorship Search',
      description: 'Search for a director by name and find all companies where they hold positions. Stitch together multiple Companies House records for the same person.',
      icon: (
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
      color: 'purple'
    },
    {
      id: 'company-timeline',
      name: 'Company Timeline',
      description: 'View a chronological history of key events for any company: incorporations, officer changes, filings, charges, PSC notifications, and more.',
      icon: (
        <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      color: 'cyan'
    }
  ]

  const colorClasses = {
    blue: {
      bg: 'bg-blue-50 hover:bg-blue-100',
      border: 'border-blue-200 hover:border-blue-400',
      icon: 'text-blue-600',
      title: 'text-blue-900'
    },
    purple: {
      bg: 'bg-purple-50 hover:bg-purple-100',
      border: 'border-purple-200 hover:border-purple-400',
      icon: 'text-purple-600',
      title: 'text-purple-900'
    },
    cyan: {
      bg: 'bg-cyan-50 hover:bg-cyan-100',
      border: 'border-cyan-200 hover:border-cyan-400',
      icon: 'text-cyan-600',
      title: 'text-cyan-900'
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Select a Module</h2>
        <p className="text-gray-600">Choose the tool you need to extract company information</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {modules.map((module) => {
          const colors = colorClasses[module.color]
          return (
            <button
              key={module.id}
              onClick={() => onSelectModule(module.id)}
              className={`${colors.bg} ${colors.border} border-2 rounded-xl p-6 text-left transition-all duration-200 hover:shadow-lg hover:scale-[1.02]`}
            >
              <div className={`${colors.icon} mb-4`}>
                {module.icon}
              </div>
              <h3 className={`text-xl font-bold ${colors.title} mb-2`}>{module.name}</h3>
              <p className="text-gray-600 text-sm">{module.description}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ============================================
// PSC Extractor Components (existing functionality)
// ============================================
function SearchResults({ results, onSelect, loading }) {
  if (loading) {
    return (
      <div className="mt-4 p-8 text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent"></div>
        <p className="mt-2 text-gray-600">Searching...</p>
      </div>
    )
  }
  if (!results || results.length === 0) return null
  return (
    <div className="mt-4 bg-white rounded-lg shadow-md overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b">
        <h3 className="font-semibold text-gray-700">Search Results ({results.length})</h3>
      </div>
      <ul className="divide-y divide-gray-200 max-h-96 overflow-y-auto">
        {results.map((company) => (
          <li key={company.company_number} onClick={() => onSelect(company.company_number)} className="px-4 py-3 hover:bg-blue-50 cursor-pointer transition-colors">
            <div className="flex justify-between items-start">
              <div>
                <p className="font-medium text-gray-900">{company.title}</p>
                <p className="text-sm text-gray-500">{company.company_number}</p>
                <p className="text-sm text-gray-500">{formatAddress(company.address)}</p>
              </div>
              <span className={`px-2 py-1 text-xs font-medium rounded-full ${company.company_status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                {company.company_status}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

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
        <div><label className="text-sm font-medium text-gray-500">Company Name</label><p className="text-gray-900 font-semibold">{company.company_name}</p></div>
        <div><label className="text-sm font-medium text-gray-500">Company Number</label><p className="text-gray-900 font-mono">{company.company_number}</p></div>
        <div><label className="text-sm font-medium text-gray-500">Status</label><p className={`inline-flex px-2 py-1 text-sm font-medium rounded-full ${company.company_status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{company.company_status?.toUpperCase()}</p></div>
        <div><label className="text-sm font-medium text-gray-500">Company Type</label><p className="text-gray-900">{company.type}</p></div>
        <div><label className="text-sm font-medium text-gray-500">Incorporated</label><p className="text-gray-900">{company.date_of_creation}</p></div>
        {company.date_of_cessation && (<div><label className="text-sm font-medium text-gray-500">Dissolved</label><p className="text-gray-900">{company.date_of_cessation}</p></div>)}
        <div className="md:col-span-2"><label className="text-sm font-medium text-gray-500">Registered Address</label><p className="text-gray-900">{formatAddress(company.registered_office_address)}</p></div>
        {company.sic_codes && company.sic_codes.length > 0 && (<div className="md:col-span-2"><label className="text-sm font-medium text-gray-500">SIC Codes</label><p className="text-gray-900">{company.sic_codes.join(', ')}</p></div>)}
      </div>
      <div className="mt-4 pt-4 border-t">
        <a href={`https://find-and-update.company-information.service.gov.uk/company/${company.company_number}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800 text-sm flex items-center gap-1">
          View on Companies House
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
        </a>
      </div>
    </div>
  )
}

function Officers({ officers }) {
  if (!officers || officers.length === 0) {
    return (<div className="bg-white rounded-lg shadow-md p-6 mb-6"><h2 className="text-xl font-bold text-gray-900 mb-4">Officers</h2><p className="text-gray-500">No officers found.</p></div>)
  }
  const activeOfficers = officers.filter(o => !o.resigned_on)
  const directors = activeOfficers.filter(o => o.officer_role?.includes('director'))
  const secretaries = activeOfficers.filter(o => o.officer_role?.includes('secretary'))
  const others = activeOfficers.filter(o => !o.officer_role?.includes('director') && !o.officer_role?.includes('secretary'))

  const OfficerCard = ({ officer }) => (
    <div className="bg-gray-50 rounded-lg p-4">
      <p className="font-semibold text-gray-900">{officer.name}</p>
      <p className="text-sm text-gray-600 capitalize">{officer.officer_role?.replace(/-/g, ' ')}</p>
      {officer.appointed_on && (<p className="text-sm text-gray-500">Appointed: {officer.appointed_on}</p>)}
      {officer.nationality && (<p className="text-sm text-gray-500">Nationality: {officer.nationality}</p>)}
      {officer.occupation && (<p className="text-sm text-gray-500">Occupation: {officer.occupation}</p>)}
      <p className="text-sm text-gray-500 mt-1">{formatAddress(officer.address)}</p>
    </div>
  )

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
        <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
        Officers ({activeOfficers.length} active)
      </h2>
      {directors.length > 0 && (<div className="mb-6"><h3 className="text-lg font-semibold text-gray-800 mb-3">Directors ({directors.length})</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{directors.map((officer, idx) => (<OfficerCard key={idx} officer={officer} />))}</div></div>)}
      {secretaries.length > 0 && (<div className="mb-6"><h3 className="text-lg font-semibold text-gray-800 mb-3">Secretaries ({secretaries.length})</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{secretaries.map((officer, idx) => (<OfficerCard key={idx} officer={officer} />))}</div></div>)}
      {others.length > 0 && (<div><h3 className="text-lg font-semibold text-gray-800 mb-3">Other Officers ({others.length})</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{others.map((officer, idx) => (<OfficerCard key={idx} officer={officer} />))}</div></div>)}
    </div>
  )
}

function PersonsWithSignificantControl({ pscs }) {
  if (!pscs || pscs.length === 0) {
    return (<div className="bg-white rounded-lg shadow-md p-6 mb-6"><h2 className="text-xl font-bold text-gray-900 mb-4">Persons with Significant Control</h2><p className="text-gray-500">No PSC information found.</p></div>)
  }
  const activePSCs = pscs.filter(psc => !psc.ceased_on)
  const individuals = activePSCs.filter(psc => psc.kind?.includes('individual'))
  const corporateEntities = activePSCs.filter(psc => psc.kind?.includes('corporate-entity'))
  const legalPersons = activePSCs.filter(psc => psc.kind?.includes('legal-person'))

  const PSCCard = ({ psc }) => (
    <div className={`rounded-lg p-4 ${psc.kind?.includes('corporate-entity') ? 'bg-purple-50 border border-purple-200' : 'bg-gray-50'}`}>
      <div className="flex items-start justify-between">
        <p className="font-semibold text-gray-900">{psc.name}</p>
        {psc.kind?.includes('corporate-entity') && (<span className="px-2 py-1 text-xs font-medium bg-purple-200 text-purple-800 rounded-full">Corporate</span>)}
      </div>
      {psc.identification && (<div className="mt-2 text-sm text-gray-600">{psc.identification.registration_number && (<p>Registration: {psc.identification.registration_number}</p>)}{psc.identification.place_registered && (<p>Registered at: {psc.identification.place_registered}</p>)}{psc.identification.legal_form && (<p>Legal form: {psc.identification.legal_form}</p>)}</div>)}
      {psc.natures_of_control && psc.natures_of_control.length > 0 && (<div className="mt-3"><p className="text-sm font-medium text-gray-700 mb-1">Nature of Control:</p><ul className="text-sm text-gray-600 space-y-1">{psc.natures_of_control.map((nature, idx) => (<li key={idx} className="flex items-center gap-1"><svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>{formatNatureOfControl(nature)}</li>))}</ul></div>)}
      {psc.date_of_birth && (<p className="text-sm text-gray-500 mt-2">DOB: {psc.date_of_birth.month}/{psc.date_of_birth.year}</p>)}
      {psc.nationality && (<p className="text-sm text-gray-500">Nationality: {psc.nationality}</p>)}
      {psc.country_of_residence && (<p className="text-sm text-gray-500">Country: {psc.country_of_residence}</p>)}
      <p className="text-sm text-gray-500 mt-1">{formatAddress(psc.address)}</p>
      {psc.notified_on && (<p className="text-sm text-gray-400 mt-2">Notified: {psc.notified_on}</p>)}
    </div>
  )

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
        <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
        Persons with Significant Control ({activePSCs.length})
      </h2>
      {individuals.length > 0 && (<div className="mb-6"><h3 className="text-lg font-semibold text-gray-800 mb-3">Individuals ({individuals.length})</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{individuals.map((psc, idx) => (<PSCCard key={idx} psc={psc} />))}</div></div>)}
      {corporateEntities.length > 0 && (<div className="mb-6"><h3 className="text-lg font-semibold text-gray-800 mb-3">Corporate Entities ({corporateEntities.length})</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{corporateEntities.map((psc, idx) => (<PSCCard key={idx} psc={psc} />))}</div></div>)}
      {legalPersons.length > 0 && (<div><h3 className="text-lg font-semibold text-gray-800 mb-3">Legal Persons ({legalPersons.length})</h3><div className="grid grid-cols-1 md:grid-cols-2 gap-4">{legalPersons.map((psc, idx) => (<PSCCard key={idx} psc={psc} />))}</div></div>)}
    </div>
  )
}

function OwnershipChainNode({ node, isRoot = false }) {
  if (!node) return null
  const hasError = node.error
  const hasPSCs = node.pscs && node.pscs.length > 0
  return (
    <div className={`relative ${!isRoot ? 'ml-8 mt-4' : ''}`}>
      {!isRoot && (<div className="absolute -left-6 top-0 h-full"><div className="absolute top-6 left-0 w-6 border-t-2 border-gray-300"></div><div className="absolute top-0 left-0 h-6 border-l-2 border-gray-300"></div></div>)}
      <div className={`rounded-lg p-4 border-2 ${isRoot ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-white'} ${hasError ? 'border-red-300 bg-red-50' : ''}`}>
        <div className="flex items-center gap-2"><div className={`w-3 h-3 rounded-full ${isRoot ? 'bg-blue-500' : hasError ? 'bg-red-500' : 'bg-green-500'}`}></div><p className="font-semibold text-gray-900">{node.company_name || node.company_number}</p></div>
        <p className="text-sm text-gray-600 font-mono ml-5">{node.company_number}</p>
        {node.company_status && (<p className={`text-sm ml-5 ${node.company_status === 'active' ? 'text-green-600' : 'text-red-600'}`}>Status: {node.company_status}</p>)}
        {hasError && (<p className="text-sm text-red-600 ml-5">Error: {node.error}</p>)}
      </div>
      {hasPSCs && (<div className="mt-2">{node.pscs.map((psc, idx) => (<div key={idx} className="relative ml-8 mt-4"><div className="absolute -left-6 top-0 h-full"><div className="absolute top-6 left-0 w-6 border-t-2 border-purple-300"></div><div className="absolute top-0 left-0 h-6 border-l-2 border-purple-300"></div></div><div className={`rounded-lg p-3 border-2 ${psc.kind?.includes('corporate-entity') ? 'border-purple-400 bg-purple-50' : 'border-green-400 bg-green-50'}`}><div className="flex items-center gap-2"><div className={`w-3 h-3 rounded-full ${psc.kind?.includes('corporate-entity') ? 'bg-purple-500' : 'bg-green-500'}`}></div><p className="font-semibold text-gray-900">{psc.name}</p></div><p className="text-xs text-gray-600 ml-5 capitalize">{psc.kind?.replace(/-/g, ' ').replace('person with significant control', 'PSC')}</p>{psc.natures_of_control && psc.natures_of_control.length > 0 && (<div className="ml-5 mt-1">{psc.natures_of_control.slice(0, 2).map((nature, nidx) => (<span key={nidx} className="text-xs text-gray-500 block">{formatNatureOfControl(nature)}</span>))}</div>)}{psc.identification?.registration_number && (<p className="text-xs text-purple-600 ml-5 font-mono">Reg: {psc.identification.registration_number}</p>)}</div>{psc.parent_chain && (<OwnershipChainNode node={psc.parent_chain} />)}</div>))}</div>)}
    </div>
  )
}

function OwnershipChain({ chain, loading, companyName }) {
  const downloadStructureChart = () => {
    if (!chain) return
    const svg = generateStructureChartSVG(chain, companyName)
    const filename = `${companyName || 'ownership-chain'}_structure_${new Date().toISOString().split('T')[0]}.svg`.replace(/[^a-zA-Z0-9_.-]/g, '_')
    downloadSVG(svg, filename)
  }
  if (loading) {
    return (<div className="bg-white rounded-lg shadow-md p-6 mb-6"><h2 className="text-xl font-bold text-gray-900 mb-4">Ownership Chain</h2><div className="flex items-center justify-center p-8"><div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-purple-500 border-t-transparent"></div><p className="ml-3 text-gray-600">Tracing ownership chain...</p></div></div>)
  }
  if (!chain) return null
  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2"><svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>Ultimate Beneficial Ownership Chain</h2>
        <button onClick={downloadStructureChart} className="px-3 py-1.5 text-sm font-medium text-purple-700 bg-purple-100 hover:bg-purple-200 rounded-lg transition-colors flex items-center gap-1"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>Download Structure Chart</button>
      </div>
      <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm text-gray-600">
        <p>This diagram traces corporate ownership through UK-registered companies to identify ultimate beneficial owners.</p>
        <div className="flex flex-wrap gap-4 mt-2"><span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-blue-500"></div> Target Company</span><span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-purple-500"></div> Corporate PSC</span><span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-green-500"></div> Individual/Legal Person</span></div>
      </div>
      <div className="overflow-x-auto"><div className="min-w-max p-4"><OwnershipChainNode node={chain} isRoot={true} /></div></div>
    </div>
  )
}

// PSC Extractor Module
function PSCExtractor({ onBack }) {
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
      const [company, officersData, pscsData] = await Promise.all([
        api.getCompany(companyNumber),
        api.getOfficers(companyNumber).catch(() => ({ items: [] })),
        api.getPSCs(companyNumber).catch(() => ({ items: [] }))
      ])
      setCompanyData(company)
      setOfficers(officersData.items || [])
      setPSCs(pscsData.items || [])
      const hasCorporatePSCs = (pscsData.items || []).some(psc => psc.kind?.includes('corporate-entity') && !psc.ceased_on)
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
    <div>
      {/* Header actions */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          Back to Modules
        </button>
        {selectedCompany && (
          <div className="flex items-center gap-2">
            <button onClick={() => { const csv = generateCSV(companyData, officers, pscs, ownershipChain); const filename = `${companyData?.company_name || selectedCompany}_${new Date().toISOString().split('T')[0]}.csv`; downloadCSV(csv, filename.replace(/[^a-zA-Z0-9_-]/g, '_')) }} disabled={!companyData} className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Download CSV
            </button>
            <button onClick={handleReset} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors">New Search</button>
          </div>
        )}
      </div>

      {/* Search Section */}
      {!selectedCompany && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Search for a Company</h2>
            <form onSubmit={handleSearch} className="space-y-4">
              <div>
                <label htmlFor="search" className="block text-sm font-medium text-gray-700 mb-1">Company name or number</label>
                <input id="search" type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="e.g., Apple UK Limited or 03977902" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors" autoFocus />
              </div>
              <button type="submit" disabled={searchLoading || !searchQuery.trim()} className="w-full px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{searchLoading ? 'Searching...' : 'Search'}</button>
            </form>
            {error && (<div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>)}
            <SearchResults results={searchResults} onSelect={handleSelectCompany} loading={searchLoading} />
          </div>
        </div>
      )}

      {/* Company Data Section */}
      {selectedCompany && (
        <div>
          {loading ? (
            <div className="flex items-center justify-center p-12"><div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-500 border-t-transparent"></div><p className="ml-4 text-lg text-gray-600">Loading company data...</p></div>
          ) : (
            <>
              {error && (<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>)}
              <CompanyProfile company={companyData} />
              <Officers officers={officers} />
              <PersonsWithSignificantControl pscs={pscs} />
              {(ownershipChain || chainLoading) && (<OwnershipChain chain={ownershipChain} loading={chainLoading} companyName={companyData?.company_name} />)}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Cross-directorship Search Components
// ============================================
function CrossDirectorshipSearch({ onBack }) {
  const [step, setStep] = useState(1) // 1: Search, 2: Select records, 3: View appointments
  const [searchQuery, setSearchQuery] = useState('')
  const [dobMonth, setDobMonth] = useState('')
  const [dobYear, setDobYear] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedOfficerIds, setSelectedOfficerIds] = useState(new Set())
  const [appointments, setAppointments] = useState(null)
  const [appointmentsLoading, setAppointmentsLoading] = useState(false)
  const [error, setError] = useState(null)

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!searchQuery.trim()) return
    setSearchLoading(true)
    setError(null)
    setSearchResults(null)
    setSelectedOfficerIds(new Set())
    try {
      // Use find-related endpoint with optional DOB filtering
      const data = await api.findRelatedOfficers(searchQuery, dobMonth || null, dobYear || null)
      if (data.items && data.items.length > 0) {
        setSearchResults(data.items)
        // Auto-select all results initially
        setSelectedOfficerIds(new Set(data.items.map(o => o.officer_id).filter(Boolean)))
        setStep(2)
      } else {
        const dobText = dobMonth && dobYear ? ` with DOB ${monthNames[parseInt(dobMonth) - 1]} ${dobYear}` : ''
        setError(`No directors found matching "${searchQuery}"${dobText}. Check the spelling${dobMonth && dobYear ? ' and date of birth' : ''}.`)
      }
    } catch (err) {
      setError('Search failed. Please try again.')
      console.error(err)
    } finally {
      setSearchLoading(false)
    }
  }

  const toggleOfficerSelection = (officerId) => {
    const newSet = new Set(selectedOfficerIds)
    if (newSet.has(officerId)) {
      newSet.delete(officerId)
    } else {
      newSet.add(officerId)
    }
    setSelectedOfficerIds(newSet)
  }

  const handleFetchAppointments = async () => {
    if (selectedOfficerIds.size === 0) {
      setError('Please select at least one record.')
      return
    }
    setAppointmentsLoading(true)
    setError(null)
    setStep(3)

    try {
      const allAppointments = []
      const seenCompanies = new Set()

      for (const officerId of selectedOfficerIds) {
        try {
          const data = await api.getOfficerAppointments(officerId)
          for (const apt of (data.items || [])) {
            // Deduplicate by company number + role
            const key = `${apt.appointed_to?.company_number}-${apt.officer_role}`
            if (!seenCompanies.has(key)) {
              seenCompanies.add(key)
              allAppointments.push(apt)
            }
          }
        } catch (err) {
          console.error(`Failed to fetch appointments for ${officerId}:`, err)
        }
      }

      // Sort by company status (active first) then by appointed date
      allAppointments.sort((a, b) => {
        const aActive = a.appointed_to?.company_status === 'active'
        const bActive = b.appointed_to?.company_status === 'active'
        if (aActive !== bActive) return bActive ? 1 : -1
        return (b.appointed_on || '').localeCompare(a.appointed_on || '')
      })

      setAppointments(allAppointments)
    } catch (err) {
      setError('Failed to fetch appointments.')
      console.error(err)
    } finally {
      setAppointmentsLoading(false)
    }
  }

  const handleReset = () => {
    setStep(1)
    setSearchQuery('')
    setDobMonth('')
    setDobYear('')
    setSearchResults(null)
    setSelectedOfficerIds(new Set())
    setAppointments(null)
    setError(null)
  }

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

  const formatDOB = (dob) => {
    if (!dob) return 'N/A'
    return `${monthNames[dob.month - 1]} ${dob.year}`
  }

  const generateAppointmentsCSV = () => {
    if (!appointments) return
    const lines = ['Company Name,Company Number,Company Status,Role,Appointed,Resigned,Address']
    for (const apt of appointments) {
      lines.push([
        escapeCSV(apt.appointed_to?.company_name),
        escapeCSV(apt.appointed_to?.company_number),
        escapeCSV(apt.appointed_to?.company_status),
        escapeCSV(apt.officer_role?.replace(/-/g, ' ')),
        escapeCSV(apt.appointed_on),
        escapeCSV(apt.resigned_on || 'Current'),
        escapeCSV(formatAddress(apt.address))
      ].join(','))
    }
    const csv = lines.join('\n')
    const filename = `${searchQuery || 'officer'}_appointments_${new Date().toISOString().split('T')[0]}.csv`.replace(/[^a-zA-Z0-9_.-]/g, '_')
    downloadCSV(csv, filename)
  }

  // Generate year options (current year back to 1920)
  const currentYear = new Date().getFullYear()
  const yearOptions = []
  for (let y = currentYear; y >= 1920; y--) {
    yearOptions.push(y)
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          Back to Modules
        </button>
        {step > 1 && (
          <button onClick={handleReset} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors">Start Over</button>
        )}
      </div>

      {/* Progress indicator */}
      <div className="mb-8">
        <div className="flex items-center justify-center gap-2">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${step >= s ? 'bg-purple-600 text-white' : 'bg-gray-200 text-gray-500'}`}>{s}</div>
              {s < 3 && <div className={`w-16 h-1 ${step > s ? 'bg-purple-600' : 'bg-gray-200'}`}></div>}
            </div>
          ))}
        </div>
        <div className="flex justify-center mt-2 text-sm text-gray-600">
          {step === 1 && 'Search by name and date of birth'}
          {step === 2 && 'Select matching records'}
          {step === 3 && 'View appointments'}
        </div>
      </div>

      {error && (<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>)}

      {/* Step 1: Search with DOB */}
      {step === 1 && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Search for a Director</h2>
            <p className="text-gray-600 mb-6">Enter the director's name. Adding date of birth helps filter results for common names.</p>
            <form onSubmit={handleSearch} className="space-y-4">
              <div>
                <label htmlFor="officer-search" className="block text-sm font-medium text-gray-700 mb-1">Director name</label>
                <input id="officer-search" type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="dob-month" className="block text-sm font-medium text-gray-700 mb-1">Month of birth <span className="text-gray-400 font-normal">(optional)</span></label>
                  <select id="dob-month" value={dobMonth} onChange={(e) => setDobMonth(e.target.value)} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors">
                    <option value="">Select month</option>
                    {monthNames.map((month, idx) => (
                      <option key={idx} value={idx + 1}>{month}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="dob-year" className="block text-sm font-medium text-gray-700 mb-1">Year of birth <span className="text-gray-400 font-normal">(optional)</span></label>
                  <select id="dob-year" value={dobYear} onChange={(e) => setDobYear(e.target.value)} className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors">
                    <option value="">Select year</option>
                    {yearOptions.map((year) => (
                      <option key={year} value={year}>{year}</option>
                    ))}
                  </select>
                </div>
              </div>
              <button type="submit" disabled={searchLoading || !searchQuery.trim()} className="w-full px-4 py-3 bg-purple-600 text-white font-medium rounded-lg hover:bg-purple-700 focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{searchLoading ? 'Searching...' : 'Search'}</button>
            </form>
            <p className="mt-4 text-xs text-gray-500 text-center">Companies House only stores month and year of birth for privacy.</p>
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-xs text-amber-700">Note: Results may not be complete due to Companies House search indexing. Some records for the same person may be stored under different name variations.</p>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Select records */}
      {step === 2 && searchResults && (
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Select Matching Records</h2>
            <p className="text-gray-600 mb-6">
              Found {searchResults.length} record{searchResults.length !== 1 ? 's' : ''}{dobMonth && dobYear ? ` for directors born in ${monthNames[parseInt(dobMonth) - 1]} ${dobYear}` : ` matching "${searchQuery}"`}.
              All records are selected by default. Uncheck any that don't belong to the person you're searching for.
            </p>

            <div className="space-y-3 max-h-[400px] overflow-y-auto mb-6">
              {searchResults.map((officer, idx) => {
                const isSelected = selectedOfficerIds.has(officer.officer_id)
                return (
                  <button
                    key={idx}
                    onClick={() => toggleOfficerSelection(officer.officer_id)}
                    className={`w-full text-left p-4 rounded-lg border-2 transition-all ${isSelected ? 'border-purple-400 bg-purple-50' : 'border-gray-200 hover:border-gray-300 bg-gray-50'}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${isSelected ? 'border-purple-500 bg-purple-500' : 'border-gray-300 bg-white'}`}>
                        {isSelected && <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
                      </div>
                      <div className="flex-grow">
                        <p className="font-semibold text-gray-900">{officer.title}</p>
                        <p className="text-sm text-gray-600">DOB: {formatDOB(officer.date_of_birth)}</p>
                        {officer.address_snippet && <p className="text-sm text-gray-500">{officer.address_snippet}</p>}
                      </div>
                      <span className="text-sm text-gray-400">{officer.appointments} appt{officer.appointments !== 1 ? 's' : ''}</span>
                    </div>
                  </button>
                )
              })}
            </div>

            <button onClick={handleFetchAppointments} disabled={selectedOfficerIds.size === 0} className="w-full px-4 py-3 bg-purple-600 text-white font-medium rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              View All Appointments ({selectedOfficerIds.size} record{selectedOfficerIds.size !== 1 ? 's' : ''} selected)
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Results */}
      {step === 3 && (
        <div className="max-w-6xl mx-auto">
          {appointmentsLoading ? (
            <div className="bg-white rounded-xl shadow-lg p-8 text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-purple-500 border-t-transparent mb-4"></div>
              <p className="text-gray-600">Loading appointments...</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-lg p-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-gray-900">Appointments for {searchQuery}</h2>
                  <p className="text-gray-600">{appointments?.length || 0} positions found across {selectedOfficerIds.size} record{selectedOfficerIds.size !== 1 ? 's' : ''}</p>
                </div>
                <button onClick={generateAppointmentsCSV} disabled={!appointments || appointments.length === 0} className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  Download CSV
                </button>
              </div>

              {appointments && appointments.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Company</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Status</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Role</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Appointed</th>
                        <th className="text-left py-3 px-4 font-semibold text-gray-700">Resigned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {appointments.map((apt, idx) => (
                        <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="py-3 px-4">
                            <a href={`https://find-and-update.company-information.service.gov.uk/company/${apt.appointed_to?.company_number}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">{apt.appointed_to?.company_name}</a>
                            <p className="text-xs text-gray-500 font-mono">{apt.appointed_to?.company_number}</p>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${apt.appointed_to?.company_status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                              {apt.appointed_to?.company_status}
                            </span>
                          </td>
                          <td className="py-3 px-4 capitalize">{apt.officer_role?.replace(/-/g, ' ')}</td>
                          <td className="py-3 px-4">{apt.appointed_on || 'N/A'}</td>
                          <td className="py-3 px-4">{apt.resigned_on || <span className="text-green-600 font-medium">Current</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">No appointments found.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Company Timeline Component
// ============================================
function CompanyTimeline({ onBack }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedCompany, setSelectedCompany] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('all')

  const handleSearch = async (e) => {
    e.preventDefault()
    if (!searchQuery.trim()) return
    setSearchLoading(true)
    setError(null)
    setSearchResults(null)
    setSelectedCompany(null)
    setTimeline(null)
    try {
      const data = await api.search(searchQuery)
      setSearchResults(data.items || [])
    } catch (err) {
      setError('Search failed. Please try again.')
      console.error(err)
    } finally {
      setSearchLoading(false)
    }
  }

  const handleSelectCompany = async (company) => {
    setSelectedCompany(company)
    setTimelineLoading(true)
    setError(null)
    try {
      const data = await api.getTimeline(company.company_number)
      setTimeline(data)
    } catch (err) {
      setError('Failed to load timeline. Please try again.')
      console.error(err)
    } finally {
      setTimelineLoading(false)
    }
  }

  const handleReset = () => {
    setSearchQuery('')
    setSearchResults(null)
    setSelectedCompany(null)
    setTimeline(null)
    setError(null)
    setFilter('all')
  }

  const categories = ['all', 'Company', 'Officers', 'Accounts', 'Confirmation', 'Charges', 'PSC', 'Address', 'Capital', 'Insolvency', 'Filing']

  const filteredEvents = timeline?.events?.filter(e => filter === 'all' || e.category === filter) || []

  const getCategoryColor = (category) => {
    const colors = {
      'Company': 'bg-blue-100 text-blue-800 border-blue-300',
      'Officers': 'bg-purple-100 text-purple-800 border-purple-300',
      'Accounts': 'bg-green-100 text-green-800 border-green-300',
      'Confirmation': 'bg-teal-100 text-teal-800 border-teal-300',
      'Charges': 'bg-red-100 text-red-800 border-red-300',
      'PSC': 'bg-orange-100 text-orange-800 border-orange-300',
      'Address': 'bg-yellow-100 text-yellow-800 border-yellow-300',
      'Capital': 'bg-indigo-100 text-indigo-800 border-indigo-300',
      'Insolvency': 'bg-rose-100 text-rose-800 border-rose-300',
      'Filing': 'bg-gray-100 text-gray-800 border-gray-300'
    }
    return colors[category] || colors['Filing']
  }

  const getEventIcon = (category) => {
    const icons = {
      'Company': '🏢',
      'Officers': '👤',
      'Accounts': '📊',
      'Confirmation': '✓',
      'Charges': '⚡',
      'PSC': '👥',
      'Address': '📍',
      'Capital': '💰',
      'Insolvency': '⚠️',
      'Filing': '📄'
    }
    return icons[category] || '📄'
  }

  const formatDate = (dateStr) => {
    if (!dateStr) return 'Unknown'
    const parts = dateStr.split('-')
    if (parts.length !== 3) return dateStr
    const [year, month, day] = parts
    return `${day}-${month}-${year.slice(-2)}`
  }

  const downloadCSV = () => {
    if (!timeline || !filteredEvents.length) return
    const lines = ['Date,Category,Event,Details']
    for (const event of filteredEvents) {
      lines.push([
        event.date || '',
        event.category || '',
        `"${(event.title || '').replace(/"/g, '""')}"`,
        `"${(event.description || '').replace(/"/g, '""')}"`
      ].join(','))
    }
    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${timeline.company?.name || 'company'}_timeline_${new Date().toISOString().split('T')[0]}.csv`.replace(/[^a-zA-Z0-9_.-]/g, '_')
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button onClick={onBack} className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          Back to Modules
        </button>
        {selectedCompany && (
          <button onClick={handleReset} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors">New Search</button>
        )}
      </div>

      {/* Title */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Company Timeline</h1>
        <p className="text-gray-600">View a chronological history of key events for any UK company</p>
      </div>

      {error && (<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>)}

      {/* Search */}
      {!selectedCompany && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-8">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Search for a Company</h2>
            <form onSubmit={handleSearch} className="space-y-4">
              <div>
                <label htmlFor="timeline-search" className="block text-sm font-medium text-gray-700 mb-1">Company name or number</label>
                <input id="timeline-search" type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="" className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 transition-colors" autoFocus />
              </div>
              <button type="submit" disabled={searchLoading || !searchQuery.trim()} className="w-full px-4 py-3 bg-cyan-600 text-white font-medium rounded-lg hover:bg-cyan-700 focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">{searchLoading ? 'Searching...' : 'Search'}</button>
            </form>
          </div>

          {/* Search Results */}
          {searchResults && searchResults.length > 0 && (
            <div className="mt-6 bg-white rounded-xl shadow-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Select a Company</h3>
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {searchResults.map((company, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSelectCompany(company)}
                    className="w-full text-left p-4 rounded-lg border-2 border-gray-200 hover:border-cyan-400 hover:bg-cyan-50 transition-all"
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-semibold text-gray-900">{company.title}</p>
                        <p className="text-sm text-gray-600">{company.company_number} • {company.company_status}</p>
                        {company.address_snippet && <p className="text-sm text-gray-500 mt-1">{company.address_snippet}</p>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {searchResults && searchResults.length === 0 && (
            <div className="mt-6 bg-white rounded-xl shadow-lg p-8 text-center text-gray-500">
              No companies found matching "{searchQuery}"
            </div>
          )}
        </div>
      )}

      {/* Loading */}
      {timelineLoading && (
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-8 text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-cyan-500 border-t-transparent mb-4"></div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Building Timeline</h2>
            <p className="text-gray-600">Gathering company history from Companies House...</p>
          </div>
        </div>
      )}

      {/* Timeline Display */}
      {timeline && !timelineLoading && (
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-xl shadow-lg p-8">
            {/* Company Header */}
            <div className="flex items-center justify-between mb-6 pb-6 border-b">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">{timeline.company?.name}</h2>
                <p className="text-gray-600">{timeline.company?.number} • {timeline.company?.status?.replace(/-/g, ' ')}</p>
              </div>
              <button onClick={downloadCSV} disabled={!filteredEvents.length} className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                Download CSV
              </button>
            </div>

            {/* Warning */}
            <div className="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm text-amber-700">⚠️ This timeline may be incomplete. For complete and authoritative information, please refer to the official <a href={`https://find-and-update.company-information.service.gov.uk/company/${timeline.company?.number}`} target="_blank" rel="noopener noreferrer" className="underline font-medium">Companies House listing</a>.</p>
            </div>

            {/* Filter */}
            <div className="mb-6">
              <div className="flex flex-wrap gap-2">
                {categories.map(cat => {
                  const count = cat === 'all' ? timeline.events?.length : timeline.events?.filter(e => e.category === cat).length
                  if (cat !== 'all' && count === 0) return null
                  return (
                    <button
                      key={cat}
                      onClick={() => setFilter(cat)}
                      className={`px-3 py-1 text-sm rounded-full border transition-colors ${filter === cat ? 'bg-cyan-600 text-white border-cyan-600' : 'bg-white text-gray-600 border-gray-300 hover:border-cyan-400'}`}
                    >
                      {cat === 'all' ? 'All' : cat} ({count})
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Timeline */}
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-6 top-0 bottom-0 w-0.5 bg-gray-200"></div>

              {/* Events */}
              <div className="space-y-4">
                {filteredEvents.map((event, idx) => (
                  <div key={idx} className="relative pl-16">
                    {/* Dot */}
                    <div className="absolute left-4 w-5 h-5 rounded-full bg-white border-2 border-gray-300 flex items-center justify-center text-xs">
                      {getEventIcon(event.category)}
                    </div>

                    {/* Event card */}
                    <div className={`p-4 rounded-lg border ${getCategoryColor(event.category)}`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-grow">
                          <p className="font-semibold">{event.title}</p>
                          {event.description && event.description !== event.title && (
                            <p className="text-sm mt-1 opacity-80">{event.description}</p>
                          )}
                          {event.documentUrl && (
                            <a href={event.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs mt-2 text-blue-600 hover:text-blue-800 hover:underline">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                              {event.category === 'Charges' ? 'View charge (inc. documents)' : 'View filing'}
                            </a>
                          )}
                        </div>
                        <div className="text-sm font-medium whitespace-nowrap">
                          {formatDate(event.date)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {filteredEvents.length === 0 && (
                <p className="text-gray-500 text-center py-8">No events found for this filter.</p>
              )}
            </div>

            {/* Summary */}
            <div className="mt-8 pt-6 border-t text-center text-sm text-gray-500">
              Showing {filteredEvents.length} of {timeline.events?.length} events
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================
// Main App Component
// ============================================
function App() {
  const [selectedModule, setSelectedModule] = useState(null)

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-6">
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
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {!selectedModule && (
          <ModuleSelector onSelectModule={setSelectedModule} />
        )}

        {selectedModule === 'psc-extractor' && (
          <PSCExtractor onBack={() => setSelectedModule(null)} />
        )}

        {selectedModule === 'cross-directorship' && (
          <CrossDirectorshipSearch onBack={() => setSelectedModule(null)} />
        )}

        {selectedModule === 'company-timeline' && (
          <CompanyTimeline onBack={() => setSelectedModule(null)} />
        )}
      </main>

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-gray-500">
        <p>Data sourced from Companies House. All information can be verified at{' '}
          <a href="https://find-and-update.company-information.service.gov.uk/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Companies House</a>
        </p>
      </footer>
    </div>
  )
}

export default App
