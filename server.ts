import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { whatsappManager } from './src/server/whatsappManager.js';
import { whatsappOrderEngine } from './src/server/whatsappOrderEngine.js';
import { sessionStore } from './src/server/sessionStore.js';
import { crmLeadStore } from './src/server/crmLeadStore.js';
import { merchantUserStore } from './src/server/merchantUserStore.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to extract tenant ID from request
function getTenantId(req: express.Request): string {
  const headerTenant = req.headers['x-tenant-id'];
  if (headerTenant && typeof headerTenant === 'string') {
    return headerTenant.trim();
  }
  const queryTenant = req.query.tenantId;
  if (queryTenant && typeof queryTenant === 'string') {
    return queryTenant.trim();
  }
  if (req.body && typeof req.body.tenantId === 'string' && req.body.tenantId.trim()) {
    return req.body.tenantId.trim();
  }
  return 'default_store';
}

/* ========================================================================= */
/* WHATSAPP & EVOLUTION API REST ENDPOINTS                                   */
/* ========================================================================= */

// 1. Health check & runtime diagnostic
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    server: 'OmniChat Fullstack Express'
  });
});

/* ========================================================================= */
/* REAL MERCHANT AUTHENTICATION ENDPOINTS                                    */
/* ========================================================================= */

// Register Merchant
app.post('/api/auth/register', (req, res) => {
  const { email, password, name, businessName, industry, country } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required' });
  }

  const result = merchantUserStore.register({
    email,
    password,
    name: name || '',
    businessName,
    industry,
    country
  });

  if (!result.success) {
    return res.status(400).json(result);
  }

  res.json({
    success: true,
    user: result.user,
    token: result.token
  });
});

// Login Merchant
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required' });
  }

  const result = merchantUserStore.login(email, password);
  if (!result.success) {
    return res.status(401).json(result);
  }

  res.json({
    success: true,
    user: result.user,
    token: result.token
  });
});

// Get User Profile by email or token
app.get('/api/auth/me', (req, res) => {
  const email = (req.query.email as string) || '';
  if (!email) {
    return res.status(400).json({ success: false, error: 'Email parameter required' });
  }
  const user = merchantUserStore.findByEmail(email);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }
  res.json({ success: true, user });
});

// 2. WhatsApp Baileys Engine Information
app.get('/api/whatsapp/config', (req, res) => {
  const allSessions = whatsappManager.getAllSessions();
  res.json({
    activeEngine: 'baileys_embedded',
    description: 'Production Baileys Multi-Device WebSocket Engine with Anti-Ban Queue',
    activeSessionsCount: allSessions.length,
    activeSessions: allSessions.map(s => ({
      tenantId: s.tenantId,
      status: s.status,
      phone: s.phone,
      engine: s.engine,
      connectedAt: s.connectedAt
    }))
  });
});

// 3. Connect WhatsApp (Generate real QR or retrieve connection)
app.post('/api/whatsapp/connect', async (req, res) => {
  const tenantId = getTenantId(req);
  const { phone, method, authMethod } = req.body;
  const chosenMethod = (authMethod || method || (phone ? 'PAIRING_CODE' : 'QR')) as 'QR' | 'PAIRING_CODE';

  try {
    const result = await whatsappManager.connectUserSession(tenantId, chosenMethod, phone);
    res.json({
      tenantId,
      ...result
    });
  } catch (err: any) {
    console.error('Error connecting WhatsApp:', err);
    res.status(500).json({
      success: false,
      tenantId,
      status: 'error',
      error: err.message || 'Failed to initiate WhatsApp connection'
    });
  }
});

// 3b. Request Real WhatsApp Pairing Code (Zero-Camera / Phone Linking)
app.post('/api/whatsapp/pairing-code', async (req, res) => {
  const tenantId = getTenantId(req);
  const { phone } = req.body;

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({
      success: false,
      tenantId,
      error: 'Please provide a valid WhatsApp phone number with country code'
    });
  }

  try {
    const result = await whatsappManager.connectUserSession(tenantId, 'PAIRING_CODE', phone);
    res.json({
      tenantId,
      ...result
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      tenantId,
      error: err.message || 'Failed to generate WhatsApp pairing code'
    });
  }
});

// 3c. Direct connectUserSession API endpoint with explicit dual auth
app.post('/api/whatsapp/user-session/connect', async (req, res) => {
  const { userId, authMethod, phoneNumber } = req.body;
  const targetUserId = userId || getTenantId(req);
  const method = authMethod === 'PAIRING_CODE' ? 'PAIRING_CODE' : 'QR';

  try {
    const result = await whatsappManager.connectUserSession(targetUserId, method, phoneNumber);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      userId: targetUserId,
      error: err.message || 'Failed to connect user session'
    });
  }
});

// 4. Get Connection Status & Live QR / Pairing Code / Anti-Ban Metrics
app.get('/api/whatsapp/status', async (req, res) => {
  const tenantId = getTenantId(req);
  const session = whatsappManager.getSession(tenantId);
  const dbSession = await sessionStore.getSession(tenantId);
  const antiBanMetrics = whatsappManager.getAntiBanMetrics(tenantId);

  if (!session) {
    return res.json({
      tenantId,
      status: dbSession?.connection_status?.toLowerCase() || 'disconnected',
      phone: dbSession?.phone_number || null,
      qrCode: null,
      pairingCode: dbSession?.pairing_code || null,
      expiresInSeconds: 0,
      pairingExpiresInSeconds: 0,
      verifiedName: null,
      error: null,
      engine: 'baileys_embedded',
      antiBanQueue: antiBanMetrics,
      dbSession: dbSession || null
    });
  }

  const expiresIn = session.qrExpiresAt
    ? Math.max(0, Math.round((session.qrExpiresAt - Date.now()) / 1000))
    : 0;

  const pairingExpiresIn = session.pairingExpiresAt
    ? Math.max(0, Math.round((session.pairingExpiresAt - Date.now()) / 1000))
    : 0;

  // Check if QR expired
  if (session.status === 'qrcode' && expiresIn === 0) {
    session.status = 'disconnected';
    session.qrCode = null;
    session.lastError = 'QR Code expired. Click Refresh to generate a fresh code.';
  }

  // Check if Pairing Code expired
  if (session.pairingCode && pairingExpiresIn === 0 && session.status !== 'connected') {
    session.pairingCode = null;
    session.pairingExpiresAt = null;
  }

  res.json({
    tenantId: session.tenantId,
    instanceName: session.instanceName,
    status: session.status,
    authMethod: session.authMethod,
    phone: session.phone,
    qrCode: session.qrCode,
    pairingCode: session.pairingCode,
    expiresInSeconds: expiresIn,
    pairingExpiresInSeconds: pairingExpiresIn,
    verifiedName: session.verifiedName,
    connectedAt: session.connectedAt,
    lastPingMs: session.lastPingMs,
    error: session.lastError,
    engine: session.engine,
    messageCount: session.messages.length,
    antiBanQueue: antiBanMetrics,
    dbSession: dbSession || null
  });
});

// 4b. Query Tracked Database Sessions
app.get('/api/whatsapp/sessions', async (req, res) => {
  try {
    const sessions = await sessionStore.getAllSessions();
    res.json({
      success: true,
      count: sessions.length,
      sessions
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4c. Anti-Ban Queue Metrics
app.get('/api/whatsapp/queue/metrics', (req, res) => {
  const tenantId = getTenantId(req);
  const metrics = whatsappManager.getAntiBanMetrics(tenantId);
  res.json({
    tenantId,
    metrics
  });
});

// 5. Disconnect / Unlink WhatsApp Device
app.post('/api/whatsapp/disconnect', async (req, res) => {
  const tenantId = getTenantId(req);
  try {
    const result = await whatsappManager.disconnect(tenantId);
    res.json({
      tenantId,
      ...result
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      tenantId,
      error: err.message || 'Failed to disconnect WhatsApp'
    });
  }
});

// 6. Send Outbound WhatsApp Message
app.post('/api/whatsapp/send', async (req, res) => {
  const tenantId = getTenantId(req);
  const { phone, text } = req.body;

  if (!phone || !text) {
    return res.status(400).json({
      success: false,
      error: 'Missing required parameters: phone and text'
    });
  }

  try {
    const result = await whatsappManager.sendMessage(tenantId, phone, text);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to send WhatsApp message'
    });
  }
});

// 7. Get WhatsApp Messages for Tenant
app.get('/api/whatsapp/messages', (req, res) => {
  const tenantId = getTenantId(req);
  const session = whatsappManager.getSession(tenantId);
  res.json({
    tenantId,
    messages: session?.messages || []
  });
});

// 8. WhatsApp Status & Health Webhook
app.get('/api/whatsapp/webhook', (req, res) => {
  res.status(200).send('WhatsApp Engine Active');
});

app.post('/api/whatsapp/webhook', (req, res) => {
  res.json({ received: true, status: 'ok' });
});

// 9. Diagnostic test endpoint to simulate an incoming message through stateful Order Engine
app.post('/api/whatsapp/test-simulation', (req, res) => {
  const tenantId = getTenantId(req);
  const { from, text, pushName } = req.body;
  const session = whatsappManager.getOrCreateSession(tenantId);

  const testSender = from || '+234 803 999 8888';
  const testText = text || 'Hi! Can I see your catalog and prices?';
  const customerName = pushName || 'Test Customer';

  const inboundMsg = {
    id: `sim_${Date.now()}`,
    from: testSender,
    to: session.phone || 'Store Phone',
    text: testText,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    direction: 'inbound' as const,
    status: 'received' as const,
    pushName: customerName,
    source: session.engine
  };

  session.messages.push(inboundMsg);

  // Auto-capture lead in CRM
  crmLeadStore.autoCaptureInbound(tenantId, testSender, customerName, testText);

  // Retrieve tenant's catalog
  const catalog = (whatsappManager as any).tenantCatalogs?.get?.(tenantId) || { storeName: 'Our WhatsApp Store', products: [], settings: null };
  
  // Process through WhatsApp Order Engine with studied store account settings
  const engineResult = whatsappOrderEngine.processMessage(
    tenantId,
    testSender,
    customerName,
    testText,
    catalog.products || [],
    catalog.storeName || 'Our WhatsApp Store',
    catalog.settings
  );

  const outboundMsg = {
    id: `sim_out_${Date.now()}`,
    from: session.phone || 'Store Phone',
    to: testSender,
    text: engineResult.replyText,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    direction: 'outbound' as const,
    status: 'sent' as const,
    source: session.engine
  };
  session.messages.push(outboundMsg);

  res.json({
    success: true,
    inbound: inboundMsg,
    reply: outboundMsg,
    currentStep: engineResult.currentStep,
    orderCreated: engineResult.orderCreated,
    orderUpdated: engineResult.orderUpdated
  });
});

// 10. Sync & Query Store Catalog with WhatsApp Bot
app.post('/api/whatsapp/catalog', (req, res) => {
  const tenantId = getTenantId(req);
  const { storeName, products, settings } = req.body;
  whatsappManager.setTenantCatalog(tenantId, storeName || 'Our WhatsApp Store', products || [], settings);
  res.json({
    success: true,
    tenantId,
    itemCount: Array.isArray(products) ? products.length : 0
  });
});

app.get('/api/whatsapp/catalog', (req, res) => {
  const tenantId = getTenantId(req);
  const catalog = (whatsappManager as any).tenantCatalogs?.get?.(tenantId) || { storeName: 'Store', products: [] };
  res.json({
    tenantId,
    storeName: catalog.storeName,
    products: catalog.products || []
  });
});

/* ========================================================================= */
/* CRM CUSTOMER LEADS & BROADCAST REST ENDPOINTS                             */
/* ========================================================================= */

// 10b. Get All Leads for Tenant (auto-captured from WhatsApp + manually imported)
app.get('/api/crm/leads', (req, res) => {
  const tenantId = getTenantId(req);
  const leads = crmLeadStore.getTenantLeads(tenantId);
  res.json({
    success: true,
    tenantId,
    count: leads.length,
    leads
  });
});

// 10c. Add or Update a Customer Lead in CRM
app.post('/api/crm/leads', (req, res) => {
  const tenantId = getTenantId(req);
  const { name, phone, email, stage, notes, tags } = req.body;

  if (!phone || !name) {
    return res.status(400).json({ success: false, error: 'Name and Phone number are required' });
  }

  const lead = crmLeadStore.addLead(tenantId, { name, phone, email, stage, notes, tags });
  res.json({
    success: true,
    tenantId,
    lead
  });
});

// 10d. Bulk Import Customer Contacts (from CSV or phone list)
app.post('/api/crm/leads/import', (req, res) => {
  const tenantId = getTenantId(req);
  const { contacts } = req.body;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'Please provide an array of contacts to import' });
  }

  const result = crmLeadStore.bulkImport(tenantId, contacts);
  res.json({
    success: true,
    tenantId,
    ...result
  });
});

// 10e. Broadcast WhatsApp Campaign to Selected Customer Leads via Anti-Ban Queue
app.post('/api/crm/broadcast', async (req, res) => {
  const tenantId = getTenantId(req);
  const messageText = req.body.messageText || req.body.message;
  const phoneNumbers = req.body.phoneNumbers || req.body.phones;

  if (!messageText || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing messageText or phoneNumbers array' });
  }

  const session = whatsappManager.getSession(tenantId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({
      success: false,
      error: 'WhatsApp device is not currently connected. Please link your phone under WhatsApp Engine tab.'
    });
  }

  const dispatchResults: Array<{ phone: string; success: boolean; error?: string }> = [];

  for (const phone of phoneNumbers) {
    try {
      const sendResult = await whatsappManager.sendMessage(tenantId, phone, messageText);
      dispatchResults.push({ phone, success: sendResult.success, error: sendResult.error });
    } catch (err: any) {
      dispatchResults.push({ phone, success: false, error: err.message });
    }
  }

  res.json({
    success: true,
    tenantId,
    totalQueued: phoneNumbers.length,
    results: dispatchResults
  });
});

// 10f. Delete Customer Lead
app.delete('/api/crm/leads/:phone', (req, res) => {
  const tenantId = getTenantId(req);
  const { phone } = req.params;
  const deleted = crmLeadStore.deleteLead(tenantId, phone);
  res.json({ success: true, deleted, tenantId });
});

/* ========================================================================= */
/* ORDER & FULFILLMENT BACKEND REST ENDPOINTS                                */
/* ========================================================================= */

// 11. List Store Orders
app.get('/api/orders', (req, res) => {
  const tenantId = getTenantId(req);
  const orders = whatsappOrderEngine.getTenantOrders(tenantId);
  res.json({
    tenantId,
    orders
  });
});

// 12. Save / Sync Order from Client
app.post('/api/orders', (req, res) => {
  const tenantId = getTenantId(req);
  const order = req.body;
  if (!order || !order.id) {
    return res.status(400).json({ success: false, error: 'Invalid order payload' });
  }
  whatsappOrderEngine.addTenantOrder(tenantId, order);
  res.json({
    success: true,
    tenantId,
    order
  });
});

// 13. Verify Gateway Payment (Never marks paid from customer claim alone)
// Triggers digital delivery if digital product, or packaging update if physical.
app.post('/api/orders/:orderId/verify-payment', async (req, res) => {
  const tenantId = getTenantId(req);
  const { orderId } = req.params;
  const { reference } = req.body;

  const result = whatsappOrderEngine.verifyOrderPayment(tenantId, orderId, reference);
  if (!result.success) {
    return res.status(404).json(result);
  }

  // If WhatsApp is connected, notify customer directly on WhatsApp using Anti-Ban Queue
  if (result.order?.customerPhone && result.notificationText) {
    try {
      await whatsappManager.sendMessage(tenantId, result.order.customerPhone, result.notificationText);
      console.log(`[Order Payment] Dispatched payment verification notification via anti-ban queue to ${result.order.customerPhone}`);
    } catch (err) {
      console.error('[Order Payment] Failed to send payment confirmation over WhatsApp:', err);
    }
  }

  res.json(result);
});

// 14. Update Order Fulfillment Status
app.post('/api/orders/:orderId/status', (req, res) => {
  const tenantId = getTenantId(req);
  const { orderId } = req.params;
  const { status } = req.body;

  const updated = whatsappOrderEngine.updateTenantOrderStatus(tenantId, orderId, status);
  if (!updated) {
    return res.status(404).json({ success: false, error: `Order ${orderId} not found` });
  }

  res.json({
    success: true,
    tenantId,
    order: updated
  });
});

/* ========================================================================= */
/* VITE MIDDLEWARE OR STATIC SERVING                                         */
/* ========================================================================= */

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(Number(PORT), '0.0.0.0', async () => {
    console.log(`> OmniChat Commerce Server running on http://0.0.0.0:${PORT}`);
    try {
      await whatsappManager.restoreExistingSessions();
    } catch (restoreErr) {
      console.warn('Session auto-restore error:', restoreErr);
    }
  });
}

startServer().catch(err => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
