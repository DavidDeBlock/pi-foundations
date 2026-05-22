// Test fixture: Basic Hono route definitions
import { Hono } from 'hono'

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))
app.post('/sales', createSaleHandler)
app.patch('/sales/:id/status', updateSaleStatusHandler)
app.delete('/sales/:id', deleteSaleHandler)

export { app }
