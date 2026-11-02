import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BookingStore } from './booking-store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4179);
const slots = process.env.BOOKING_SLOTS_JSON ? JSON.parse(process.env.BOOKING_SLOTS_JSON) : [];
const store = new BookingStore({ slots });
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/booking' && req.method === 'GET') { json(res, 200, { ok: true, bookings: store.list({ role: url.searchParams.get('role'), sale: url.searchParams.get('sale') || undefined }) }); return; }
    if (url.pathname === '/booking' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'create') { const booking = await store.create(body); json(res, 200, { ok: true, bookingId: booking.bookingId, booking, backup: 'dev-json' }); return; }
      if (body.action === 'confirm' || body.action === 'reject') { const booking = await store.transition(body.bookingId, body.action === 'confirm' ? 'confirmed' : 'rejected'); json(res, 200, { ok: true, bookingId: booking.bookingId, status: booking.status }); return; }
      json(res, 400, { ok: false, error: 'Неизвестное действие' }); return;
    }
    if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'Метод не поддерживается' }); return; }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'booking-ui.js'].includes(file)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
    res.end(await fs.readFile(path.join(root, file)));
  } catch (error) { json(res, error.statusCode || 500, { ok: false, error: error.message }); }
}).listen(port, '127.0.0.1', () => console.log(`Booking dev server http://localhost:${port}`));
