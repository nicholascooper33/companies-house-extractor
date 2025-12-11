# Companies House Extractor

A web application for extracting company information from the UK Companies House API. Search for companies by name or number, view company details, officers, and trace ultimate beneficial ownership through corporate structures.

## Features

- **Company Search**: Search by company name or company number
- **Company Profile**: View key company information (status, type, incorporation date, address, SIC codes)
- **Officers**: View active directors and company secretaries
- **Persons with Significant Control (PSC)**: View individuals and corporate entities with significant control
- **Ownership Chain Visualization**: Automatically trace corporate ownership chains to identify ultimate beneficial owners for UK-registered parent companies

## Prerequisites

- Node.js 18+
- A Companies House API key (free from [Companies House Developer Hub](https://developer.company-information.service.gov.uk/))

## Setup

### 1. Clone the repository

```bash
git clone <repository-url>
cd companies-house-extractor
```

### 2. Install dependencies

```bash
npm run install:all
```

Or manually:
```bash
cd backend && npm install
cd ../frontend && npm install
```

### 3. Configure API Key

Create a `.env` file in the `backend` directory:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and add your Companies House API key:

```
COMPANIES_HOUSE_API_KEY=your_api_key_here
```

### 4. Run the application

In development mode (runs both frontend and backend):

```bash
npm run dev
```

Or run them separately:

```bash
# Terminal 1 - Backend (runs on port 3001)
npm run dev:backend

# Terminal 2 - Frontend (runs on port 3000)
npm run dev:frontend
```

### 5. Access the application

Open your browser to [http://localhost:3000](http://localhost:3000)

## API Endpoints

The backend exposes these endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=<query>` | Search for companies by name or number |
| `GET /api/company/:companyNumber` | Get company profile |
| `GET /api/company/:companyNumber/officers` | Get company officers |
| `GET /api/company/:companyNumber/pscs` | Get persons with significant control |
| `GET /api/company/:companyNumber/ownership-chain` | Trace corporate ownership chain |
| `GET /api/health` | Health check |

## Companies House API Information

This application uses the [Companies House Public Data API](https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference):

- **Base URL**: `https://api.company-information.service.gov.uk/`
- **Authentication**: HTTP Basic Auth with API key as username
- **Rate Limit**: 600 requests per 5 minutes (2 per second)
- **Data Source**: All data comes directly from Companies House and can be verified at [find-and-update.company-information.service.gov.uk](https://find-and-update.company-information.service.gov.uk/)

## Ownership Chain Tracing

When a company has corporate entities as Persons with Significant Control, the application automatically traces ownership chains for UK-registered parent companies. This is done by:

1. Identifying corporate PSCs with registration numbers at Companies House
2. Recursively fetching PSC data for each parent company
3. Building a visual tree showing the ownership chain up to 10 levels deep

**Note**: The ownership chain only follows UK-registered companies. Foreign parent companies cannot be traced through this API.

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React, Vite, Tailwind CSS
- **API**: Companies House Public Data API

## License

MIT
