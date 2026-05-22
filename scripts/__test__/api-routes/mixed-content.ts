// Test fixture: Mixed — routes alongside service functions and types
import { Hono } from 'hono'
import type { Sale, Customer } from '../../shared/types.js'

const app = new Hono()

// Sales endpoints
app.get('/sales', listSales)
app.post('/sales', createSale)
app.patch('/sales/:id/void', voidSaleHandler)

// Customer endpoints  
app.get('/customers', listCustomers)
app.post('/customers', createCustomer)

export { app }

function listSales() { /* ... */ }
function createSale() { /* ... */ }
function voidSaleHandler() { /* ... */ }
function listCustomers() { /* ... */ }
function createCustomer() { /* ... */ }
