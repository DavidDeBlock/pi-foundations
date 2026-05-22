// Test fixture: Routes with middleware (should still extract method + path)
import { Hono } from 'hono'
import { authMiddleware } from '../lib/middleware.js'

const app = new Hono()

app.get('/dashboard', authMiddleware, dashboardHandler)
app.post('/api/sales', authMiddleware, createSale)
app.delete('/api/cache/:key', clearCacheHandler)

export { app }
