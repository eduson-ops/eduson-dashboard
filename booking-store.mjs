import { canTransition, findExistingByIdempotencyKey } from './booking-core.mjs';

export class BookingConflictError extends Error {
  constructor(message) { super(message); this.name = 'BookingConflictError'; this.statusCode = 409; }
}

export class BookingStore {
  constructor({ slots = [], bookings = [] } = {}) { this.slots = slots; this.bookings = bookings; this.writeChain = Promise.resolve(); }

  async create(booking, createdAt = new Date().toISOString()) {
    return this.#queue(async () => {
      const existing = findExistingByIdempotencyKey(this.bookings, booking.idempotencyKey);
      if (existing) return existing;
      const capacity = this.slots.filter(s => s.date === booking.date && s.time === booking.time && s.manager === booking.sale && String(s.status).toLowerCase() === 'wait').length;
      const used = this.bookings.filter(b => b.date === booking.date && b.time === booking.time && b.sale === booking.sale && ['pending_confirmation', 'confirmed'].includes(b.status)).length;
      if (used >= capacity) throw new BookingConflictError('Свободных мест в этом слоте больше нет');
      const next = { ...booking, createdAt, place: booking.place || used + 1 };
      this.bookings.push(next);
      return next;
    });
  }

  list({ role, sale } = {}) {
    return this.bookings.filter(booking => role === 'confirmation_manager'
      ? booking.status === 'pending_confirmation'
      : role === 'sales'
        ? booking.status === 'confirmed' && (!sale || booking.sale === sale)
        : true);
  }

  async transition(bookingId, status) {
    return this.#queue(async () => {
      const booking = this.bookings.find(item => item.bookingId === bookingId);
      if (!booking) throw new Error('Запись не найдена');
      if (!canTransition(booking.status, status)) throw new Error(`Переход ${booking.status} → ${status} запрещён`);
      booking.status = status;
      booking.updatedAt = new Date().toISOString();
      return booking;
    });
  }

  #queue(operation) { this.writeChain = this.writeChain.then(operation, operation); return this.writeChain; }
}
