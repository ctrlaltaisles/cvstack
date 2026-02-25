# CVStack

CVStack uses a Vite + React frontend and an Express + TypeScript backend.

## Current Frontend Stack

- Framework: React 18
- Routing: `react-router` (browser router)
- Build tool: Vite 6
- Styling: Tailwind CSS 4 + utility classes
- Component primitives: Radix UI + custom UI wrappers
- Animation: `motion`
- State management: local React state (`useState`, `useEffect`), no global store

## Main User Flows

- Onboarding: landing page (`/`) to start page (`/start`)
- Import options: LinkedIn placeholder, PDF upload import, manual start
- Resume editor: base resume + role-specific versions inside `/workspace`
- Export: print-based PDF/Word export controls in workspace toolbar

## Backend setup

### 1) Start Postgres (Docker)

```bash
docker compose up -d
```

### 2) Frontend env

```bash
cp .env.example .env
```

Set:

- `VITE_API_BASE_URL=http://localhost:4000`

### 3) Backend env

```bash
cp server/.env.example server/.env
```

Important backend vars:

- `DATABASE_URL=postgresql://cvstack:cvstack@localhost:5432/cvstack?schema=public`
- `PORT=4000`
- `CORS_ORIGIN=http://localhost:5173`
- `AUTH_SECRET=change-this-secret`
- `UPLOAD_DIR=./uploads`

### 4) Install backend deps and initialize Prisma

```bash
cd server
npm install
npm run prisma:generate
npm run prisma:migrate
```

### 5) Optional: migrate old JSON data (dev only)

```bash
npm run db:migrate-json
```

### 6) Run apps

Frontend:

```bash
npm install
npm run dev
```

Backend:

```bash
cd server
npm run dev
```

### 7) Optional seed

```bash
cd server
npm run seed
```

Default seed credentials: `demo@cvstack.dev` / `demo12345`.

## Backend API coverage (stable contracts)

- Auth: email/password register + login + current user endpoint
- Profile: basic user profile read/update
- Resumes: create/list/read/update
- Resume versions: create/list/update
- PDF upload: save PDF file + extract text + parse basic fields + prefill base resume
