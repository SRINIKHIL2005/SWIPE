# Swipe Invoice AI

A React + Redux app that uploads Excel, PDFs, and images of invoices, extracts structured data with a generic AI pipeline (Google Gemini), and keeps Invoices, Products, and Customers in sync across tabs.

## Features

- File uploads (multiple) with progress and errors
- AI-powered extraction for PDF/Images; heuristics + optional AI normalization for Excel
- Three tabs with live updates via Redux: Invoices, Products, Customers
- Inline edits for Products and Customers reflected instantly in Invoices
- Missing fields highlighted (e.g., missing product/customer names)
- Ready to deploy: GitHub Pages (frontend) + Render/Vercel/Netlify (backend)

## Local Dev

1. Backend
   - Copy `server/.env.example` to `server/.env` and set `GOOGLE_API_KEY`
   - Run:
   ```cmd
   cd server
   npm install
   npm run dev
   ```
   - Server runs at http://localhost:5050

2. Frontend
   - Run:
   ```cmd
   cd client
   npm install
   npm run dev
   ```
   - Open the shown localhost URL

Optional: set `VITE_API_BASE` in `client/.env` if backend URL differs.

## Deployment

- Frontend: GitHub Pages via workflow `.github/workflows/gh-pages.yml`.
  - After pushing to your repo, enable GitHub Pages for the repo (Deploy from GitHub Actions).
  - The Vite base is auto-inferred in CI.

- Backend: any Node host. Suggested:
  - Render free web service: point to `server`, start command `npm start`.
  - Vercel: create a project from `server`, set `GOOGLE_API_KEY` env var.
  - Netlify functions are possible but not included in this repo structure.

## AI Extraction

- Uses Google Gemini 1.5 (via `@google/generative-ai`) with file uploads for PDFs/Images.
- Excel files are parsed with `xlsx` and normalized; if API key is present, you can route Excel through Gemini for consistency.

## Test Cases

Place the assignment test files and upload them:
- Case-1: Invoice PDFs
- Case-2: Invoice PDFs + Images
- Case-3: Excel File
- Case-4: Excel Files
- Case-5: All types

For missing fields, the UI marks them as "missing"; you can edit directly in Products/Customers.

## Screenshots / Video

- Add screenshots in `docs/` and link here after running the cases.
