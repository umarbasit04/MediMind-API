# MediMind API

Secure REST API for medication reminders and adherence tracking.

## Features

- JWT authentication with seven-day tokens
- bcrypt password hashing
- PostgreSQL access through the existing schema
- User-scoped medicines, reminders, adherence logs, emergency contacts, and family members
- Swagger UI at `/api/docs`
- Health check at `/health`
- Docker-ready

## Run locally

```bash
npm ci
cp .env.example .env
npm start
```

Set these environment variables in `.env` or your hosting provider:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | Existing PostgreSQL connection string |
| `JWT_SECRET` | Long random signing secret |
| `PORT` | Server port, defaults to `5000` |
| `FRONTEND_URL` | Allowed frontend origin |

The database tables must already exist. This API does not run migrations or recreate tables.

## Deploy from GitHub

Create a free web service from this repository on a Node/Docker-compatible host:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Add the four environment variables above

The included `Dockerfile` can be used by hosts that deploy directly from containers.

## API documentation

After starting the server, open:

```text
http://localhost:5000/api/docs/
```

Use Swagger's **Authorize** button with:

```text
Bearer <token returned by login>
```