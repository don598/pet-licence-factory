# Pet Licence Factory

## Overview

Pet Licence Factory is a web-based product that lets users create custom "pet driver's licence" credit card skins. Users pick a pet, fill in licence details (name, DOB, address, etc.), upload a photo, and order a printed card-skin sticker shipped to their door.

The experience is themed as a retro pixel-art factory with animated sprite characters at five stations. There is a desktop landing page with a starfield and interactive card showcase, a separate mobile-optimised welcome page, and a multi-station game/builder page where the actual licence is assembled.

## Tech Stack

- **Frontend:** Static HTML/CSS/JS (no framework). Uses `Press Start 2P` and `Sacramento` Google Fonts. All pages are self-contained single-file HTML with inline styles and scripts.
- **Shared logic:** `plf-shared.js` -- common engine used by both desktop (`game.html`) and mobile (`mobile.html`) builder pages. Handles order submission (via serverless function), Stripe checkout initiation, pricing, sprite animation, and canvas-based licence rendering.
- **Backend / Serverless:** Cloudflare Pages Functions (Node.js-compatible) for order submission, Stripe checkout session creation, webhook handling, and admin API. Functions live in `functions/api/`.
- **Database:** AWS RDS PostgreSQL on shared instance (`lessoncomplete-db.c9e2648w8z0z.us-east-2.rds.amazonaws.com`), database `petlicencefactory`. Schema defined in `rds_setup.sql`. Connected via Cloudflare Hyperdrive binding (`functions/_shared/db.js`).
- **Payments:** Stripe Checkout (server-side session creation, webhook for fulfilment).
- **Hosting:** Cloudflare Pages (static site from `public/`, functions from `functions/`). GitHub repo: `don598/pet-licence-factory` (public). Auto-deploys on push to `main`.
- **Audio:** Web Audio API -- `public/music-toggle.js` provides a chiptune ambient pad + melody sequencer with a floating play/pause button. `tools/daw.html` is a full DAW for composing chiptune music.
- **Animation:** 12-frame sprite sheets (PNG strips at 1200% width) animated via CSS `background-position` stepping, driven by JS `requestAnimationFrame`.
- **AI / ML (client-side):**
  - `@imgly/background-removal` v1.7.0 (IS-Net) for automatic pet photo background removal
  - SAM (Segment Anything Model) ViT-B via ONNX for interactive click-to-segment in the photo editor
  - Both run entirely in-browser via `onnxruntime-web` v1.21.0 loaded through import maps
- **Shipping:** EasyPost for shipping label generation and tracking.
- **Email:** SendGrid for transactional order emails.
- **Dependencies (server-side only):** `stripe`, `pg`, `bcryptjs`, `jsonwebtoken`, `sharp` (image processing).

## How to Run Locally

The project uses `npx http-server`. Three launch configurations are defined in `.claude/launch.json`:

```bash
# Serve dev tools (sprite builder, DAW, pixel art editors)
npx http-server . -p 8765 -c-1

# Serve the public/ directory (what end-users see)
npx http-server public -p 8766 -c-1

# Serve the tools/ directory (PLF Music Studio DAW)
npx http-server tools -p 8767 -c-1
```

There is also a `Launch.html` at the project root that acts as a local preview launcher with links to all major pages, dev tools (now under `tools/`), and the Music Studio.

For serverless functions locally, use `wrangler pages dev public` with a `.env` file. See `.env.example` for required keys (DATABASE_URL, Stripe, Admin, SendGrid, EasyPost).

## Directory Structure

```
/
├── public/                     # Production site root (deployed via Cloudflare Pages)
│   ├── index.html              # Desktop landing page (starfield, factory preview, card showcase)
│   ├── mobile-welcome.html     # Mobile landing page (touch-optimised welcome)
│   ├── game.html               # Desktop licence builder (5 stations + checkout)
│   ├── mobile.html             # Mobile licence builder
│   ├── success.html            # Post-checkout order confirmation page
│   ├── admin.html              # Admin dashboard (order management via admin-api, Fabric.js canvas)
│   ├── command-station.html    # PLF Command Station (admin/ops dashboard + photo editor)
│   ├── music-toggle.js         # Web Audio chiptune player with floating UI toggle
│   ├── _headers                # Cloudflare Pages security headers (CSP, etc.)
│   └── images/                 # All image assets for the site
│       ├── Station {1-5} background.png   # Station background scenes
│       ├── Station {1-5} sprite.png       # 12-frame sprite sheets (cat, cockatoo, bulldog, otter, rabbit)
│       ├── Station {1-5} sprite.gif       # GIF fallback versions
│       ├── Station 3 background {closed,open}.png  # Extra variants for station 3
│       ├── Blank Card*.{png,jpeg,webp}    # Card template images
│       ├── Card With Placeholders.png     # Card layout with placeholder fields
│       ├── Game Canvas Background.webp    # Game scene background
│       ├── classic-chip.png / mini-chip.png  # Chip overlay images for cards
│       ├── Large Chip Reference.png / Small Chip Reference.png
│       ├── mobile/                        # Mobile-specific station backgrounds
│       │   └── Station {1-6} background mobile.png
│       └── preview-licences/              # Pre-made sample licence images for homepage showcase
│           ├── luna-whiskers.png
│           ├── max-woofington.png
│           └── oliver-pawsley.png
│
├── functions/                  # Cloudflare Pages Functions (serverless backend)
│   ├── _shared/
│   │   └── db.js               # Shared pg connection helper (via Cloudflare Hyperdrive)
│   └── api/
│       ├── admin-api.js        # Admin API (JWT auth, order/task CRUD via pg)
│       ├── create-checkout-session.js  # Stripe Checkout session creator
│       ├── submit-order.js     # Order submission (generates order ID, validates, inserts into RDS)
│       └── stripe-webhook.js   # Stripe webhook handler (updates RDS on payment)
│
├── tools/                      # Dev tools (not deployed)
│   ├── cat.html                # Pixel art tabby cat renderer (canvas)
│   ├── human.html              # Pixel art human character renderer (canvas)
│   ├── sprite-builder.html     # Full sprite sheet builder/editor
│   ├── pixel-extractor.html    # Pixel colour extractor from images
│   ├── sprite-preview.html     # Sprite animation preview (large, ~20MB)
│   ├── sprite-preview-homepage.html  # Homepage sprite positioning preview
│   ├── sprite-preview-mobile.html    # Mobile sprite positioning preview
│   ├── daw.html                # PLF Music Studio -- chiptune DAW for composing game music
│   ├── generate-sprite.js      # Node script: sprite generation helper
│   ├── save-sprite-data.js     # Node script: save sprite data to JSON
│   ├── sprite-data.json        # Sprite metadata
│   └── test-pixelate.js        # Node script: pixelation test utility
│
├── netlify/                    # LEGACY — old Netlify Functions (superseded by functions/)
│   └── functions/              # Kept for reference only, not deployed
│
├── plf-shared.js               # Shared JS engine (order submission via fetch, pricing,
│                               #   sprite animation, canvas licence rendering, checkout flow)
│
├── Launch.html                 # Local dev launcher page (links to all pages + tools/ + Music Studio)
│
├── wrangler.toml               # Cloudflare Pages config (Hyperdrive binding, compatibility flags)
├── rds_setup.sql               # RDS database schema (pet_orders + admin_tasks tables)
├── supabase_setup.sql          # Legacy schema reference (was used before RDS migration)
├── netlify.toml                # LEGACY — old Netlify config (kept for reference)
├── package.json                # Node dependencies (stripe, pg, bcryptjs, jsonwebtoken, sharp)
├── .env.example                # Environment variable template
├── .gitignore                  # Excludes .env, node_modules, _archive/, .claude/,
│                               #   _preview_licenses_temp/, CCA/, legal/
│
├── legal/                      # IP/legal documents (gitignored)
├── CCA/                        # Physical product files -- PSD, DXF cut files (gitignored)
├── _archive/                   # Archived source media, old sprites, screenshots (gitignored)
└── _preview_licenses_temp/     # Temp preview licence images (gitignored)
```

## Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | Desktop landing page. Starfield canvas, split layout with title + card showcase on left, animated factory window on right. Redirects mobile users to `mobile-welcome.html`. |
| `public/mobile-welcome.html` | Mobile landing. Touch-optimised version of the landing page. |
| `public/game.html` | The core product. 5-station licence builder: photo upload, pet details, customisation, review, checkout. |
| `public/mobile.html` | Mobile version of the licence builder. |
| `public/success.html` | Post-checkout order confirmation page shown after Stripe redirect. |
| `public/admin.html` | Admin dashboard for viewing/managing orders. Uses admin-api function and Fabric.js for canvas operations. |
| `public/command-station.html` | Ops dashboard ("PLF Command Station"). Includes AI background removal, interactive photo editor with brush tools and SAM click-to-segment, licence card generation, order management, and task tracking. |
| `public/music-toggle.js` | Self-contained IIFE that injects a floating music button. Web Audio API with ambient sine pad + triangle-wave melody sequencer. Persists play state via `localStorage`. |
| `plf-shared.js` | ~49KB shared engine. Order submission (via fetch to submit-order function), Stripe checkout redirect, pricing constants, sprite animation loop, canvas-based licence card rendering. Used by both `game.html` and `mobile.html`. |
| `functions/_shared/db.js` | Shared pg connection helper using Cloudflare Hyperdrive for AWS RDS. |
| `functions/api/admin-api.js` | Admin API. JWT-based auth with bcrypt password verification. Handles order listing, updates, task CRUD. |
| `functions/api/submit-order.js` | Server-side order submission. Generates order ID, validates input, inserts into RDS. Called from game/mobile pages via fetch. |
| `functions/api/create-checkout-session.js` | Creates Stripe Checkout sessions. Handles 1-pack/2-pack pricing, decal add-on, discount calculation, shipping tiers. |
| `functions/api/stripe-webhook.js` | Processes `checkout.session.completed` events. Updates RDS order with payment status and shipping address. |
| `tools/daw.html` | PLF Music Studio. Full chiptune DAW for composing game music with sequencer, waveform selection, and export. |
| `tools/sprite-builder.html` | Interactive sprite sheet builder/editor for creating 12-frame animation strips. |
| `rds_setup.sql` | Full schema for the `pet_orders` and `admin_tasks` tables with indexes and auto-update trigger. |
| `wrangler.toml` | Cloudflare Pages config. Sets `pages_build_output_dir = "public"`, Hyperdrive binding for RDS. |
| `Launch.html` | Local dev convenience page with links to homepage, game, mobile, admin, tools, and Music Studio. |

## Architecture Notes

- **Static site architecture:** Everything is vanilla HTML/CSS/JS with no build step. Pages load Google Fonts from CDNs. The shared engine (`plf-shared.js`) is loaded via `<script>` tag.
- **Cloudflare Pages deployment:** `wrangler.toml` sets `pages_build_output_dir = "public"`. Functions in `functions/` are deployed as Cloudflare Pages Functions. Security headers configured in `public/_headers`.
- **Database connection:** All database access goes through Cloudflare Pages Functions (server-side only). The `db.js` helper connects via Cloudflare Hyperdrive to the shared AWS RDS instance. No database credentials or connection strings exist in client-side code.
- **Sprite animation system:** Each of the 5 animal characters (cat, cockatoo, bulldog, otter, rabbit) has a 12-frame sprite sheet stored as a single horizontal PNG strip. Animation is achieved by stepping `background-position-x` through 12 positions (each at `background-size: 1200% 100%`).
- **Mobile detection:** The desktop landing page (`index.html`) checks `navigator.userAgent` and `window.innerWidth` on load and redirects mobile users to `mobile-welcome.html`.
- **Payment flow:** User builds licence in `game.html` -> order saved to RDS via `submit-order` function -> Stripe Checkout session created via `create-checkout-session` function -> user pays on Stripe -> webhook updates order status to 'paid' -> redirect to `success.html`.
- **Admin auth:** Admin pages use JWT-based authentication via the `admin-api` function. Password is verified against a bcrypt hash stored in `ADMIN_PASSWORD_HASH` env var. JWT tokens expire after 8 hours.
- **Photo editor (Command Station):** After auto background removal via `@imgly/background-removal`, admins can open an interactive photo editor with restore/remove brushes (adjustable size, undo/redo) and SAM click-to-segment (Segment Anything Model via ONNX). SAM models (~200MB total) are cached in IndexedDB after first download. The editor works on an alpha mask overlaid on the original photo with a checkerboard transparency preview.
- **ONNX runtime CSP:** Both the background removal library and SAM require `unsafe-eval` and `wasm-unsafe-eval` in the CSP `script-src` directive. The `ort.env.wasm.wasmPaths` property is locked via `Object.defineProperty` to prevent the library from overwriting CDN paths with blob: URLs.
- **Audio system:** `music-toggle.js` creates a Web Audio context on first user interaction. Plays an ambient sine-wave pad (A3 + E4) with a slow LFO breathing effect, plus a triangle-wave melody arpeggio sequencer. Exposes `window.PLFMusic` API for melody replacement. The `tools/daw.html` Music Studio provides a full DAW for composing new chiptune tracks.

## Environment Variables

All secrets are stored in Cloudflare Pages environment variables (dashboard or `wrangler pages secret put`) and locally in `.env`. See `.env.example` for the full list:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string for AWS RDS (`postgresql://plf_admin:...@lessoncomplete-db...`) |
| `STRIPE_SECRET_KEY` | Stripe API secret key (test or live) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (used in checkout redirect) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook endpoint signing secret |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of admin password |
| `ADMIN_JWT_SECRET` | Secret for signing admin JWT tokens |
| `EASYPOST_API_KEY` | EasyPost API key for shipping label generation |
| `SENDGRID_API_KEY` | SendGrid API key for transactional emails |
| `SENDGRID_FROM_EMAIL` | Sender email address for SendGrid |
| `SENDGRID_FROM_NAME` | Sender display name for SendGrid |

Note: Cloudflare Hyperdrive is configured in `wrangler.toml` with binding `HYPERDRIVE` and handles the RDS connection pooling.

## Deployment

- **Site URL:** https://pet-licence-factory.pages.dev/
- **GitHub:** https://github.com/don598/pet-licence-factory (public)
- **Auto-deploy:** Pushes to `main` branch trigger automatic Cloudflare Pages deploys.
- **Stripe webhook endpoint:** Must be configured in Stripe Dashboard pointing to the Cloudflare Pages URL
  - Events: `checkout.session.completed`

## Project History

- **Initial build:** 12-frame sprite system, 5-station game flow, Supabase for database.
- **Security hardening (2026-04-13):** Removed exposed Supabase keys from frontend, created server-side admin API with JWT auth.
- **RDS migration (2026-04-13):** Fully migrated from Supabase to AWS RDS PostgreSQL. All Supabase dependencies removed. Order submission moved from browser-side Supabase insert to server-side function. Database now on shared RDS instance alongside Muphonic and Lesson Complete projects.
- **Cloudflare Pages migration (2026-04):** Migrated hosting from Netlify to Cloudflare Pages (hit Netlify free tier bandwidth limits). Serverless functions moved from `netlify/functions/` to `functions/api/`. Database connection now uses Cloudflare Hyperdrive. Old `netlify/` directory kept for reference.
- **Photo editor (2026-04-14):** Added interactive photo editor to Command Station with restore/remove brush tools, SAM (Segment Anything Model) click-to-segment via ONNX, undo/redo, and checkerboard transparency preview.
