# Todo API Contract

**Version**: 1.0.0  
**Status**: ✅ Active  
**Created**: 2026-04-18  
**Last Updated**: 2026-04-18  
**Owner**: Backend Lead  

---

## Overview

This document defines the API contract for the Todo feature, including endpoints, request/response formats, and error handling.

---

## Base URL

```
Development: http://localhost:3000/api
Staging: https://api-staging.example.com/api
Production: https://api.example.com/api
```

---

## Authentication

All endpoints (except `/auth/*`) require authentication via HTTP-only JWT cookie.

**Request Headers**:
```http
Cookie: jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Endpoints

### Create Todo

**POST `/api/todos`**

**Authentication**: Required  

**Request Body**:
```json
{
  "title": string (required, 1-200 chars),
  "description": string (optional)
}
```

**Success Response** (201 Created):
```json
{
  "id": "uuid-string",
  "title": "Buy groceries",
  "description": "Milk, eggs, bread",
  "completed": false,
  "createdAt": "2026-04-18T10:00:00Z",
  "updatedAt": "2026-04-18T10:00:00Z"
}
```

**Error Responses**:
- `400 Bad Request` - Validation error
- `401 Unauthorized` - Missing or invalid token
- `500 Internal Server Error` - Server error

---

### List Todos

**GET `/api/todos`**

**Authentication**: Required  

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Max results to return |
| `offset` | integer | 0 | Pagination offset |
| `completed` | boolean | - | Filter by completion status |

**Success Response** (200 OK):
```json
[
  {
    "id": "uuid-string",
    "title": "Buy groceries",
    "description": "Milk, eggs, bread",
    "completed": false,
    "createdAt": "2026-04-18T10:00:00Z",
    "updatedAt": "2026-04-18T10:00:00Z"
  }
]
```

**Error Responses**:
- `401 Unauthorized` - Missing or invalid token

---

### Get Single Todo

**GET `/api/todos/:id`**

**Authentication**: Required  

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Todo ID (UUID) |

**Success Response** (200 OK):
```json
{
  "id": "uuid-string",
  "title": "Buy groceries",
  "description": "Milk, eggs, bread",
  "completed": false,
  "createdAt": "2026-04-18T10:00:00Z",
  "updatedAt": "2026-04-18T10:00:00Z"
}
```

**Error Responses**:
- `401 Unauthorized` - Missing or invalid token
- `404 Not Found` - Todo not found

---

### Update Todo

**PUT `/api/todos/:id`**

**Authentication**: Required  

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Todo ID (UUID) |

**Request Body**:
```json
{
  "title": string (optional, 1-200 chars),
  "description": string (optional),
  "completed": boolean (optional)
}
```

**Success Response** (200 OK):
```json
{
  "id": "uuid-string",
  "title": "Updated title",
  "description": "Milk, eggs, bread",
  "completed": true,
  "createdAt": "2026-04-18T10:00:00Z",
  "updatedAt": "2026-04-18T10:05:00Z"
}
```

**Error Responses**:
- `400 Bad Request` - Validation error
- `401 Unauthorized` - Missing or invalid token
- `404 Not Found` - Todo not found

---

### Delete Todo

**DELETE `/api/todos/:id`**

**Authentication**: Required  

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Todo ID (UUID) |

**Success Response** (204 No Content):
```http
HTTP/1.1 204 No Content
```

**Error Responses**:
- `401 Unauthorized` - Missing or invalid token
- `404 Not Found` - Todo not found

---

## Error Format

All errors follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": [
      {"field": "title", "message": "Title is required"}
    ]
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Input validation failed |
| `AUTHENTICATION_ERROR` | 401 | Missing or invalid token |
| `NOT_FOUND` | 404 | Resource not found |
| `INTERNAL_ERROR` | 500 | Server error (unexpected) |

---

## Rate Limiting

**Limit**: 100 requests per minute per authenticated user  
**Headers**:
```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1681824000
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-04-18 | Initial API contract |

---

## Related Documentation

- [Server API Guide](../server-api.md) - Complete API reference
- [Client API Guide](../client-api.md) - Frontend usage patterns
- [Tech Stack](../../08-reference/tech-stack.md) - Technology choices

---

**Last Updated**: 2026-04-18  
**Review Status**: Active  
**Next Review Date**: Per major change
