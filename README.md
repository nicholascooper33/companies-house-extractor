# Companies House Extractor

A web application for extracting company information from the UK Companies House API. Search for companies by name or number, view company details, officers, and trace ultimate beneficial ownership through corporate structures.

## Features

- **Company Search**: Search by company name or company number
- **Company Profile**: View key company information (status, type, incorporation date, address, SIC codes)
- **Officers**: View active directors and company secretaries
- **Persons with Significant Control (PSC)**: View individuals and corporate entities with significant control
- **Ownership Chain Visualization**: Automatically trace corporate ownership chains to identify ultimate beneficial owners for UK-registered parent companies

---

## Step-by-Step Installation Guide

### Prerequisites

Before starting, ensure you have:
- **Node.js 18+** installed ([download here](https://nodejs.org/))
- **Git** installed ([download here](https://git-scm.com/))
- A **Companies House API key** (free - instructions below)

### Step 1: Get Your Companies House API Key

1. Go to [Companies House Developer Hub](https://developer.company-information.service.gov.uk/)
2. Click **"Register"** or **"Sign in"** (top right)
3. Create an account with your email
4. Once logged in, go to **"Your applications"**
5. Click **"Create an application"**
6. Fill in the form:
   - **Application name**: e.g., "Companies House Extractor"
   - **Application description**: e.g., "Company information lookup tool"
   - **Application environment**: Select **"Live"**
7. Click **"Create"**
8. On the application page, click **"Create new key"**
9. Select **"REST API key"**
10. Copy and save your API key securely (you'll need it in Step 4)

### Step 2: Clone the Repository

Open your terminal/command prompt and run:

```bash
git clone <repository-url>
cd companies-house-extractor
```

### Step 3: Install Dependencies

Run the following command to install all required packages:

```bash
npm run install:all
```

This installs dependencies for both the backend and frontend.

**Alternative (manual installation):**
```bash
cd backend && npm install
cd ../frontend && npm install
cd ..
```

### Step 4: Configure Your API Key

1. Create the environment file:
   ```bash
   cp backend/.env.example backend/.env
   ```

2. Open `backend/.env` in a text editor:
   ```bash
   # On Mac/Linux
   nano backend/.env

   # On Windows (use Notepad or any text editor)
   notepad backend\.env
   ```

3. Replace `your_api_key_here` with your actual API key:
   ```
   COMPANIES_HOUSE_API_KEY=abc123your_actual_key_here
   PORT=3001
   ```

4. Save and close the file

### Step 5: Start the Application

**Option A - Run both servers together:**
```bash
npm run dev
```

**Option B - Run servers separately (recommended for development):**

Open two terminal windows:

```bash
# Terminal 1 - Start the backend
npm run dev:backend
```

```bash
# Terminal 2 - Start the frontend
npm run dev:frontend
```

### Step 6: Access the Application

Open your browser and go to: **http://localhost:3000**

You should see the Companies House Extractor interface. Try searching for a company like "Tesco" or by company number "00445790".

---

## Optional: Hosting Publicly

If you want to make your application available on the internet, here are several options:

### Option A: Railway (Recommended - Easiest)

Railway offers simple deployment with free tier available.

#### 1. Prepare the project for Railway

First, we need to modify the project structure slightly. Create a combined server that serves both API and frontend:

```bash
# In the project root, create a production server
```

Create `server.js` in the project root:

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const CH_API_BASE = 'https://api.company-information.service.gov.uk';

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// API helper
async function fetchFromCompaniesHouse(endpoint) {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
  if (!apiKey) throw new Error('API key not configured');

  const response = await fetch(`${CH_API_BASE}${endpoint}`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64')
    }
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}

// API routes
app.get('/api/search', async (req, res) => {
  try {
    const { q, items_per_page = 20 } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    const data = await fetchFromCompaniesHouse(`/search/companies?q=${encodeURIComponent(q)}&items_per_page=${items_per_page}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/company/:companyNumber', async (req, res) => {
  try {
    const data = await fetchFromCompaniesHouse(`/company/${req.params.companyNumber}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/company/:companyNumber/officers', async (req, res) => {
  try {
    const data = await fetchFromCompaniesHouse(`/company/${req.params.companyNumber}/officers`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/company/:companyNumber/pscs', async (req, res) => {
  try {
    const data = await fetchFromCompaniesHouse(`/company/${req.params.companyNumber}/persons-with-significant-control`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ownership chain tracing
async function traceOwnershipChain(companyNumber, depth = 0, maxDepth = 10, visited = new Set()) {
  if (depth >= maxDepth || visited.has(companyNumber)) return null;
  visited.add(companyNumber);

  try {
    const companyProfile = await fetchFromCompaniesHouse(`/company/${companyNumber}`);
    let pscs = { items: [] };
    try {
      pscs = await fetchFromCompaniesHouse(`/company/${companyNumber}/persons-with-significant-control`);
    } catch (e) {}

    const result = {
      company_number: companyNumber,
      company_name: companyProfile.company_name,
      company_status: companyProfile.company_status,
      depth: depth,
      pscs: []
    };

    if (pscs.items) {
      for (const psc of pscs.items) {
        if (psc.ceased_on) continue;
        const pscInfo = {
          name: psc.name,
          kind: psc.kind,
          natures_of_control: psc.natures_of_control || [],
          address: psc.address
        };

        if (psc.kind === 'corporate-entity-person-with-significant-control' && psc.identification) {
          pscInfo.identification = psc.identification;
          const regNumber = psc.identification.registration_number;
          if (regNumber && psc.identification.place_registered?.toLowerCase().includes('companies house')) {
            const formattedNumber = regNumber.toString().padStart(8, '0');
            pscInfo.parent_chain = await traceOwnershipChain(formattedNumber, depth + 1, maxDepth, visited);
          }
        }
        result.pscs.push(pscInfo);
      }
    }
    return result;
  } catch (error) {
    return { company_number: companyNumber, error: error.message, depth: depth };
  }
}

app.get('/api/company/:companyNumber/ownership-chain', async (req, res) => {
  try {
    const chain = await traceOwnershipChain(req.params.companyNumber);
    res.json(chain);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', apiKeyConfigured: !!process.env.COMPANIES_HOUSE_API_KEY });
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
```

#### 2. Update package.json

Add to root `package.json`:
```json
{
  "scripts": {
    "start": "node server.js",
    "build": "cd frontend && npm install && npm run build"
  }
}
```

#### 3. Deploy to Railway

1. Go to [railway.app](https://railway.app/) and sign up/login with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your repository
4. Railway will auto-detect Node.js
5. Go to **Variables** tab and add:
   - `COMPANIES_HOUSE_API_KEY` = your API key
6. Railway will build and deploy automatically
7. Click **"Generate Domain"** to get your public URL

---

### Option B: Render

#### 1. Prepare for Render

Use the same `server.js` from Option A.

#### 2. Deploy to Render

1. Go to [render.com](https://render.com/) and sign up
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Configure:
   - **Name**: companies-house-extractor
   - **Runtime**: Node
   - **Build Command**: `cd frontend && npm install && npm run build`
   - **Start Command**: `node server.js`
5. Add environment variable:
   - `COMPANIES_HOUSE_API_KEY` = your API key
6. Click **"Create Web Service"**

---

### Option C: Vercel + Railway (Separate Frontend/Backend)

This approach hosts frontend on Vercel (free) and backend on Railway.

#### 1. Deploy Backend to Railway

1. Create a new Railway project from the `backend` folder
2. Add `COMPANIES_HOUSE_API_KEY` environment variable
3. Note your backend URL (e.g., `https://your-backend.railway.app`)

#### 2. Update Frontend for Production

Edit `frontend/src/App.jsx`, change the API helper:

```javascript
const API_BASE = import.meta.env.VITE_API_URL || '';

const api = {
  search: async (query) => {
    const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`)
    // ...
  },
  // Update all other methods similarly
}
```

#### 3. Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com/) and sign up
2. Import your GitHub repository
3. Set:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Vite
4. Add environment variable:
   - `VITE_API_URL` = `https://your-backend.railway.app`
5. Deploy

---

### Option D: DigitalOcean / VPS (Full Control)

For a VPS with full control:

#### 1. Set up your server

```bash
# SSH into your server
ssh user@your-server-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Clone your repository
git clone <your-repo-url>
cd companies-house-extractor
```

#### 2. Build and configure

```bash
# Install dependencies
npm run install:all

# Build frontend
cd frontend && npm run build && cd ..

# Create production server (use server.js from Option A)

# Create .env file
echo "COMPANIES_HOUSE_API_KEY=your_key_here" > .env
echo "PORT=3001" >> .env
```

#### 3. Start with PM2

```bash
pm2 start server.js --name companies-house
pm2 save
pm2 startup
```

#### 4. Set up Nginx (optional, for domain/SSL)

```bash
sudo apt install nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/companies-house
```

Add:
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/companies-house /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

#### 5. Add SSL with Certbot

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## Troubleshooting

### "API key not configured" error
- Ensure `backend/.env` exists and contains your API key
- Check there are no spaces around the `=` sign
- Restart the backend server after changes

### "Search failed" error
- Verify your API key is valid at Companies House Developer Hub
- Check you haven't exceeded rate limits (600 requests per 5 minutes)

### Frontend not loading
- Ensure both backend (port 3001) and frontend (port 3000) are running
- Check browser console for errors

### Production deployment issues
- Ensure `COMPANIES_HOUSE_API_KEY` is set in your hosting environment variables
- Check deployment logs for build errors

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/search?q=<query>` | Search for companies by name or number |
| `GET /api/company/:companyNumber` | Get company profile |
| `GET /api/company/:companyNumber/officers` | Get company officers |
| `GET /api/company/:companyNumber/pscs` | Get persons with significant control |
| `GET /api/company/:companyNumber/ownership-chain` | Trace corporate ownership chain |
| `GET /api/health` | Health check |

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React, Vite, Tailwind CSS
- **API**: Companies House Public Data API

## License

MIT
