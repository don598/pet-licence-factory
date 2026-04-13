# Pet Licence Factory

## Overview

Pet Licence Factory is a web-based product that lets users create custom "pet driver's licence" credit card skins. Users pick a pet, fill in licence details (name, DOB, address, etc.), upload a photo, and order a printed card-skin sticker shipped to their door.

The experience is themed as a retro pixel-art factory with animated sprite characters at five stations. There is a desktop landing page with a starfield and interactive card showcase, a separate mobile-optimised welcome page, and a multi-station game/builder page where the actual licence is assembled.

## Tech Stack

- **Frontend:** Static HTML/CSS/JS (no framework). Uses `Press Start 2P` and `Sacramento` Google Fonts. All pages are self-contained single-file HTML with inline styles and scripts.
- **Shared logic:** `plf-shared.js` -- common engine used by both desktop (`game.html`) and mobile (`mobile.html`) builder pages. Handles Supabase order submission, Stripe checkout initiation, pricing, sprite animation, and canvas-based licence rendering.
- **Backend / Serverless:** Netlify Functions (Node.js) for Stripe checkout session creation and webhook handling.
- **Database:** Supabase (PostgreSQL) for order storage. Schema defined in `supabase_setup.sql`.
- **Payments:** Stripe Checkout (server-side session creation, webhook for fulfilment).
- **Hosting:** Netlify (static site deployed from `public/`, functions from `netlify/functions/`).
- **Audio:** Web Audio API -- `public/music-toggle.js` provides a chiptune ambient pad + melody sequencer with a floating play/pause button. `tools/daw.html` is a full DAW for composing chiptune music.
- **Animation:** 12-frame sprite sheets (PNG strips at 1200% width) animated via CSS `background-position` stepping, driven by JS `requestAnimationFrame`.
- **Dependencies (server-side only):** `stripe`, `@supabase/supabase-js`, `sharp` (image processing).

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

For Netlify Functions (Stripe checkout), you need `netlify dev` with a `.env` file. See `.env.example` for required keys (Stripe, Supabase, SendGrid, Shippo).

## Directory Structure

```
/
├── public/                     # Production site root (deployed to Netlify via publish = "public/")
│   ├── index.html              # Desktop landing page (starfield, factory preview, card showcase)
│   ├── mobile-welcome.html     # Mobile landing page (touch-optimised welcome)
│   ├── game.html               # Desktop licence builder (5 stations + checkout)
│   ├── mobile.html             # Mobile licence builder
│   ├── success.html            # Post-checkout order confirmation page
│   ├── admin.html              # Admin dashboard (Supabase-powered order management, Fabric.js canvas)
│   ├── command-station.html    # PLF Command Station (admin/ops dashboard)
│   ├── music-toggle.js         # Web Audio chiptune player with floating UI toggle
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
├── tools/                      # Dev tools (not deployed -- excluded via .netlifyignore)
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
├── netlify/
│   └── functions/
│       ├── create-checkout-session.js     # Stripe Checkout session creator (pricing, line items)
│       └── stripe-webhook.js              # Stripe webhook handler (updates Supabase on payment)
│
├── plf-shared.js               # Shared JS engine (Supabase client, order submission, pricing,
│                               #   sprite animation, canvas licence rendering, checkout flow)
│
├── Launch.html                 # Local dev launcher page (links to all pages + tools/ + Music Studio)
│
├── supabase_setup.sql          # Database schema (pet_orders table, RLS policies)
├── netlify.toml                # Netlify build + headers config (publish = "public/", functions = "netlify/functions")
├── package.json                # Node dependencies (stripe, supabase-js, sharp)
├── .env.example                # Environment variable template
├── .netlifyignore              # Excludes CCA/, legal/, tools/, _preview_licenses_temp/,
│                               #   Launch.html, plf-shared.js, and other non-production files
├── .gitignore                  # Excludes .env, node_modules, _archive/, .claude/,
│                               #   _preview_licenses_temp/, CCA/, legal/
│
├── legal/                      # IP/legal documents (gitignored, netlifyignored)
├── CCA/                        # Physical product files -- PSD, DXF cut files (gitignored, netlifyignored)
├── _archive/                   # Archived source media, old sprites, screenshots (gitignored)
└── _preview_licenses_temp/     # Temp preview licence images (gitignored, netlifyignored)
```

## Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | Desktop landing page. Starfield canvas, split layout with title + card showcase on left, animated factory window on right. Redirects mobile users to `mobile-welcome.html`. |
| `public/mobile-welcome.html` | Mobile landing. Touch-optimised version of the landing page. |
| `public/game.html` | The core product. 5-station licence builder: photo upload, pet details, customisation, review, checkout. Uses `plf-shared.js`. |
| `public/mobile.html` | Mobile version of the licence builder. |
| `public/success.html` | Post-checkout order confirmation page shown after Stripe redirect. |
| `public/admin.html` | Admin dashboard for viewing/managing orders. Uses Supabase JS client and Fabric.js for canvas operations. |
| `public/command-station.html` | Ops dashboard ("PLF Command Station"). |
| `public/music-toggle.js` | Self-contained IIFE that injects a floating music button. Web Audio API with ambient sine pad + triangle-wave melody sequencer. Persists play state via `localStorage`. |
| `plf-shared.js` | ~49KB shared engine. Supabase client init, order submission, Stripe checkout redirect, pricing constants, sprite animation loop, canvas-based licence card rendering. Used by both `game.html` and `mobile.html`. |
| `netlify/functions/create-checkout-session.js` | Creates Stripe Checkout sessions. Handles 1-pack/2-pack pricing, decal add-on, discount calculation, shipping tiers. |
| `netlify/functions/stripe-webhook.js` | Processes `checkout.session.completed` events. Updates Supabase order with payment status and shipping address. |
| `tools/daw.html` | PLF Music Studio. Full chiptune DAW for composing game music with sequencer, waveform selection, and export. |
| `tools/sprite-builder.html` | Interactive sprite sheet builder/editor for creating 12-frame animation strips. |
| `supabase_setup.sql` | Full schema for the `pet_orders` table with all licence fields, payment tracking, and RLS policies. |
| `Launch.html` | Local dev convenience page with links to homepage, game, mobile, admin, tools, and Music Studio. |

## Architecture Notes

- **Static site architecture:** Everything is vanilla HTML/CSS/JS with no build step. Pages load Google Fonts and Supabase JS from CDNs. The shared engine (`plf-shared.js`) is loaded via `<script>` tag.
- **Netlify deployment:** The root `netlify.toml` sets `publish = "public/"` and `functions = "netlify/functions"`. Only the `public/` directory is deployed to production. Dev tools, legal files, CCA assets, and other non-production files are excluded via `.netlifyignore`.
- **Sprite animation system:** Each of the 5 animal characters (cat, cockatoo, bulldog, otter, rabbit) has a 12-frame sprite sheet stored as a single horizontal PNG strip. Animation is achieved by stepping `background-position-x` through 12 positions (each at `background-size: 1200% 100%`).
- **Mobile detection:** The desktop landing page (`index.html`) checks `navigator.userAgent` and `window.innerWidth` on load and redirects mobile users to `mobile-welcome.html`.
- **Payment flow:** User builds licence in `game.html` -> order saved to Supabase -> Stripe Checkout session created via Netlify Function -> user pays on Stripe -> webhook updates order status -> redirect to `success.html`.
- **Audio system:** `music-toggle.js` creates a Web Audio context on first user interaction. Plays an ambient sine-wave pad (A3 + E4) with a slow LFO breathing effect, plus a triangle-wave melody arpeggio sequencer. Exposes `window.PLFMusic` API for melody replacement. The `tools/daw.html` Music Studio provides a full DAW for composing new chiptune tracks.

## Project Cleanup (Completed)

The project was restructured to separate production files from dev tools and eliminate root-level duplicates:

- **Root duplicates removed:** `index.html`, `mobile-welcome.html`, `mobile.html`, `game.html`, and `images/` no longer exist at root. Canonical versions live exclusively in `public/`.
- **`public/netlify.toml` deleted:** Was a confusing duplicate of the root config. Only the root `netlify.toml` exists now.
- **`netlify.toml` updated:** Now publishes from `public/` instead of `.` (root), so only production files are deployed.
- **Dev tools moved to `tools/`:** `cat.html`, `human.html`, `sprite-builder.html`, `pixel-extractor.html`, `sprite-preview*.html`, `generate-sprite.js`, `save-sprite-data.js`, `sprite-data.json`, and `test-pixelate.js` relocated from root.
- **`success.html`, `admin.html`, `command-station.html` moved to `public/`:** These are production pages and now live alongside the other deployed files.
- **`.netlifyignore` expanded:** Excludes `CCA/`, `legal/`, `tools/`, `_preview_licenses_temp/`, `Launch.html`, and `plf-shared.js` from deploys.
- **`.gitignore` expanded:** Excludes `_preview_licenses_temp/`, `CCA/`, and `legal/` from version control.
- **`Launch.html` updated:** Links now point to `tools/` paths and includes a new Music Studio button for `tools/daw.html`.
