# HoneyChain — Vercel-ready Flask prototype

## Deploy with Vercel CLI

Install Node.js first, then:

```bash
npm install -g vercel
vercel login
cd HoneyChain_Vercel
vercel
```

For production:

```bash
vercel --prod
```

When Vercel asks for settings, the defaults are normally fine. The included `vercel.json` routes requests to `api/index.py`.

## After deployment

Your live URLs will be:

- `https://YOUR-DOMAIN.vercel.app/`
- `https://YOUR-DOMAIN.vercel.app/verify/HC-KVIC-2026-0827-001`
- `https://YOUR-DOMAIN.vercel.app/verify/HC-KVIC-2026-0827-002`
- `https://YOUR-DOMAIN.vercel.app/verify/HC-KVIC-2026-0827-003`

The home page displays three QR codes. Each QR is generated dynamically from the current deployment URL, so you do not need to edit the domain into the code.

## QR codes

The QR image endpoints are:

`/qr/HC-KVIC-2026-0827-001`
`/qr/HC-KVIC-2026-0827-002`
`/qr/HC-KVIC-2026-0827-003`

Print those images and attach one to each demo bottle.

## Important

The AI, IoT, lab values, GPS/transport data, and blockchain hashes are simulated demonstration data. They should be presented as prototype/mock records unless you connect real systems.
