// Cloudflare Pages Function for Stew Night API
// Handles events, users, and authentication via Cloudflare KV

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ADMIN_PASSWORD = 'Stewmaster';
const USER_PASSWORD = 'Dannystew';

function verifyPassword(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const password = authHeader.substring(7);
  if (password === ADMIN_PASSWORD) return 'admin';
  if (password === USER_PASSWORD) return 'user';
  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth check endpoint doesn't need a valid token yet
  if (path === 'auth' && request.method === 'POST') {
    return handleAuth(request);
  }

  const role = verifyPassword(request);
  if (!role) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    if (path === 'events') {
      return handleEvents(request, env, role);
    } else if (path.startsWith('events/')) {
      const id = path.split('/')[1];
      return handleEvent(request, env, role, id);
    } else if (path === 'users') {
      return handleUsers(request, env, role);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('API Error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Auth handler
function handleAuth(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing credentials' }, 401);
  }
  const password = authHeader.substring(7);
  if (password === ADMIN_PASSWORD) {
    return jsonResponse({ role: 'admin' });
  } else if (password === USER_PASSWORD) {
    return jsonResponse({ role: 'user' });
  }
  return jsonResponse({ error: 'Invalid password' }, 401);
}

// Events handlers
async function handleEvents(request, env, role) {
  if (request.method === 'GET') {
    const data = await env.STEW_KV.get('events');
    const events = data ? JSON.parse(data) : [];
    return jsonResponse(events);
  } else if (request.method === 'POST') {
    if (role !== 'admin') {
      return jsonResponse({ error: 'Admin only' }, 403);
    }
    const event = await request.json();
    event.id = 'evt_' + Date.now().toString();
    event.rsvps = [];

    const data = await env.STEW_KV.get('events');
    const events = data ? JSON.parse(data) : [];
    events.push(event);

    await env.STEW_KV.put('events', JSON.stringify(events));
    return jsonResponse(event, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleEvent(request, env, role, id) {
  const data = await env.STEW_KV.get('events');
  const events = data ? JSON.parse(data) : [];

  if (request.method === 'PUT') {
    const updates = await request.json();
    const index = events.findIndex(e => e.id === id);
    if (index === -1) {
      return jsonResponse({ error: 'Event not found' }, 404);
    }

    events[index] = { ...events[index], ...updates };
    await env.STEW_KV.put('events', JSON.stringify(events));
    return jsonResponse(events[index]);
  } else if (request.method === 'DELETE') {
    if (role !== 'admin') {
      return jsonResponse({ error: 'Admin only' }, 403);
    }
    const filtered = events.filter(e => e.id !== id);
    await env.STEW_KV.put('events', JSON.stringify(filtered));
    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// Users handlers
async function handleUsers(request, env, role) {
  if (request.method === 'GET') {
    const data = await env.STEW_KV.get('users');
    const users = data ? JSON.parse(data) : [];
    return jsonResponse(users);
  } else if (request.method === 'POST') {
    const user = await request.json();
    user.id = (role === 'admin' ? 'admin_' : 'user_') + Date.now().toString();

    const data = await env.STEW_KV.get('users');
    const users = data ? JSON.parse(data) : [];

    const exists = users.find(u => u.email.toLowerCase() === user.email.toLowerCase());
    if (exists) {
      return jsonResponse({ error: 'Email already registered' }, 409);
    }

    users.push(user);
    await env.STEW_KV.put('users', JSON.stringify(users));
    return jsonResponse(user, 201);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}
