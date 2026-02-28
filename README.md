# VoiceSafe Backend

Enterprise backend API for VoiceSafe AI Voice Scam Detection.

## Features

- AI voice analysis proxy
- Upload normalization
- Stripe subscription verification
- Case storage (MVP memory store)
- Health monitoring
- Request tracing (x-request-id)

## Endpoints

### Health
GET /health

### Analyze
POST /upload
POST /analyze

multipart/form-data:
file=<audio>

### Cases
GET /cases
GET /case/:id

### Stripe
POST /create-checkout-session
POST /create-portal-session
GET /verify-session

## Run locally

npm install
npm run dev

## Production

Render auto deploy.