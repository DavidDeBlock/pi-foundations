// Test fixture: Nested router patterns (common in Hono)
import { Hono } from 'hono'

const api = new Hono()
const products = new Hono()

api.get('/status', statusHandler)

products.get('/', listProducts)
products.post('/', createProduct)
products.get('/:id', getProduct)
products.patch('/:id', updateProduct)
products.delete('/:id', deleteProduct)

api.route('/products', products)

export { api, products }
