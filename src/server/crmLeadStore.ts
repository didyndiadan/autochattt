import fs from 'fs';
import path from 'path';

export interface CustomerLeadRecord {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  email?: string;
  stage: 'lead' | 'qualified' | 'customer' | 'vip' | 'abandoned';
  notes: string;
  totalSpend: number;
  lastActive: string;
  assignedStaff: string;
  lastMessagePreview?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  source: 'whatsapp_inbound' | 'manual_add' | 'csv_import';
}

class CrmLeadStore {
  private leads = new Map<string, CustomerLeadRecord>();
  private readonly dbDir = path.resolve(process.cwd(), 'storage', 'database');
  private readonly dbFilePath = path.join(this.dbDir, 'crm_leads.json');
  private isLoaded = false;

  constructor() {
    this.ensureStorage();
    this.loadFromDisk();
  }

  private ensureStorage(): void {
    if (!fs.existsSync(this.dbDir)) {
      try {
        fs.mkdirSync(this.dbDir, { recursive: true });
      } catch (err) {
        console.error('[CrmLeadStore] Failed to create database directory:', err);
      }
    }
  }

  private sanitizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (!digits) return phone;
    // Common Nigerian local 11-digit phone number e.g. 0803..., 0812..., 0901..., 0705...
    if (digits.startsWith('0') && digits.length === 11) {
      return `+234${digits.substring(1)}`;
    }
    return digits.startsWith('+') ? digits : `+${digits}`;
  }

  private getLeadKey(tenantId: string, phone: string): string {
    const cleanTenant = (tenantId || 'store_aura_main').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cleanPhone = phone.replace(/\D/g, '');
    return `${cleanTenant}::${cleanPhone}`;
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.dbFilePath)) {
        const raw = fs.readFileSync(this.dbFilePath, 'utf-8');
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && item.phone) {
                const key = this.getLeadKey(item.tenantId || 'store_aura_main', item.phone);
                this.leads.set(key, item);
              }
            }
          }
        }
      }
      this.isLoaded = true;
    } catch (err) {
      console.error('[CrmLeadStore] Error reading CRM leads database:', err);
      this.isLoaded = true;
    }
  }

  private persistToDisk(): void {
    try {
      this.ensureStorage();
      const all = Array.from(this.leads.values());
      const tempPath = `${this.dbFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(all, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.dbFilePath);
    } catch (err) {
      console.error('[CrmLeadStore] Error writing CRM leads to disk:', err);
    }
  }

  /**
   * Auto-captures or updates a customer when they send an inbound WhatsApp message.
   */
  public autoCaptureInbound(tenantId: string, phone: string, pushName: string, messageText: string): CustomerLeadRecord {
    const key = this.getLeadKey(tenantId, phone);
    const existing = this.leads.get(key);
    const now = new Date().toISOString();
    const formattedPhone = phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`;

    if (existing) {
      existing.lastActive = 'Just now';
      existing.lastMessagePreview = messageText;
      existing.updatedAt = now;
      if (pushName && (!existing.name || existing.name === 'WhatsApp Customer' || existing.name === 'New Lead')) {
        existing.name = pushName;
      }
      this.persistToDisk();
      return existing;
    }

    const newLead: CustomerLeadRecord = {
      id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      tenantId: tenantId || 'store_aura_main',
      name: pushName || 'WhatsApp Customer',
      phone: formattedPhone,
      stage: 'lead',
      notes: 'Auto-captured from WhatsApp incoming inquiry.',
      totalSpend: 0,
      lastActive: 'Just now',
      assignedStaff: 'AI Sales Agent',
      lastMessagePreview: messageText,
      tags: ['whatsapp_inbound', 'auto_captured'],
      createdAt: now,
      updatedAt: now,
      source: 'whatsapp_inbound'
    };

    this.leads.set(key, newLead);
    this.persistToDisk();
    console.log(`[CrmLeadStore] Auto-captured new lead: ${newLead.name} (${newLead.phone})`);
    return newLead;
  }

  /**
   * Returns all leads for a tenant.
   */
  public getTenantLeads(tenantId: string): CustomerLeadRecord[] {
    const cleanTenant = (tenantId || 'store_aura_main').replace(/[^a-zA-Z0-9_-]/g, '_');
    return Array.from(this.leads.values())
      .filter(l => (l.tenantId || 'store_aura_main') === cleanTenant)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  }

  /**
   * Upsert a manual lead.
   */
  public addLead(tenantId: string, lead: Partial<CustomerLeadRecord> & { phone: string; name: string }): CustomerLeadRecord {
    const formattedPhone = this.sanitizePhone(lead.phone);
    const key = this.getLeadKey(tenantId, formattedPhone);
    const existing = this.leads.get(key);
    const now = new Date().toISOString();

    if (existing) {
      const updated: CustomerLeadRecord = {
        ...existing,
        ...lead,
        phone: formattedPhone,
        updatedAt: now
      };
      this.leads.set(key, updated);
      this.persistToDisk();
      return updated;
    }

    const created: CustomerLeadRecord = {
      id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      tenantId: tenantId || 'store_aura_main',
      name: lead.name.trim(),
      phone: formattedPhone,
      email: lead.email,
      stage: lead.stage || 'lead',
      notes: lead.notes || 'Manually added to CRM.',
      totalSpend: lead.totalSpend || 0,
      lastActive: 'Never',
      assignedStaff: lead.assignedStaff || 'Store Manager',
      lastMessagePreview: lead.lastMessagePreview || 'No messages yet',
      tags: lead.tags || ['manual_lead'],
      createdAt: now,
      updatedAt: now,
      source: 'manual_add'
    };

    this.leads.set(key, created);
    this.persistToDisk();
    return created;
  }

  /**
   * Bulk import leads from phone numbers or CSV data.
   */
  public bulkImport(tenantId: string, items: Array<{ phone: string; name?: string; email?: string; notes?: string }>): {
    importedCount: number;
    updatedCount: number;
    leads: CustomerLeadRecord[];
  } {
    let imported = 0;
    let updated = 0;

    for (const item of items) {
      if (!item.phone) continue;
      const formatted = this.sanitizePhone(item.phone);
      const cleanDigits = formatted.replace(/\D/g, '');
      if (cleanDigits.length < 8) continue;

      const key = this.getLeadKey(tenantId, formatted);
      const existing = this.leads.get(key);
      const now = new Date().toISOString();

      if (existing) {
        if (item.name && (!existing.name || existing.name === 'WhatsApp Customer')) {
          existing.name = item.name;
        }
        if (item.email && !existing.email) existing.email = item.email;
        if (item.notes) existing.notes = `${existing.notes} | ${item.notes}`;
        existing.updatedAt = now;
        updated++;
      } else {
        const newLead: CustomerLeadRecord = {
          id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          tenantId: tenantId || 'store_aura_main',
          name: item.name?.trim() || `Customer ${formatted.slice(-4)}`,
          phone: formatted,
          email: item.email,
          stage: 'lead',
          notes: item.notes || 'Imported via CSV/Bulk Contact List.',
          totalSpend: 0,
          lastActive: 'Never',
          assignedStaff: 'Sales Specialist',
          lastMessagePreview: 'Imported Contact',
          tags: ['imported_contact'],
          createdAt: now,
          updatedAt: now,
          source: 'csv_import'
        };
        this.leads.set(key, newLead);
        imported++;
      }
    }

    this.persistToDisk();
    return {
      importedCount: imported,
      updatedCount: updated,
      leads: this.getTenantLeads(tenantId)
    };
  }

  /**
   * Syncs contacts directly from WhatsApp Business companion link (history, contacts.upsert, chats).
   */
  public syncWhatsAppContacts(
    tenantId: string,
    contacts: Array<{ jid?: string; phone?: string; name?: string; notify?: string; verifiedName?: string }>
  ): { syncedCount: number; leads: CustomerLeadRecord[] } {
    const cleanTenant = (tenantId || 'store_aura_main').replace(/[^a-zA-Z0-9_-]/g, '_');
    let count = 0;

    for (const item of contacts) {
      const rawJid = item.jid || item.phone || '';
      if (!rawJid || rawJid.endsWith('@g.us') || rawJid.includes('broadcast') || rawJid.includes('status')) {
        continue;
      }

      const digits = rawJid.split('@')[0].replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) {
        // Exclude internal LID hashes or invalid digits
        continue;
      }

      const formatted = this.sanitizePhone(digits);
      const key = this.getLeadKey(cleanTenant, formatted);
      const existing = this.leads.get(key);
      const now = new Date().toISOString();
      const displayName = item.verifiedName || item.name || item.notify || `WhatsApp Contact (+${digits.slice(-4)})`;

      if (existing) {
        if (displayName && (!existing.name || existing.name === 'WhatsApp Customer' || existing.name.startsWith('Customer '))) {
          existing.name = displayName;
        }
        if (!existing.tags?.includes('whatsapp_contact')) {
          existing.tags = [...(existing.tags || []), 'whatsapp_contact'];
        }
        existing.updatedAt = now;
      } else {
        const newLead: CustomerLeadRecord = {
          id: `lead_wa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          tenantId: cleanTenant,
          name: displayName,
          phone: formatted,
          stage: 'lead',
          notes: 'Synchronized from linked WhatsApp Business account contacts.',
          totalSpend: 0,
          lastActive: 'Synced from WhatsApp',
          assignedStaff: 'AI Sales Agent',
          lastMessagePreview: 'WhatsApp Business Contact',
          tags: ['whatsapp_contact', 'synced_account'],
          createdAt: now,
          updatedAt: now,
          source: 'whatsapp_inbound'
        };
        this.leads.set(key, newLead);
        count++;
      }
    }

    if (count > 0) {
      this.persistToDisk();
      console.log(`[CrmLeadStore:${cleanTenant}] Synced ${count} new contacts from WhatsApp account.`);
    }

    return {
      syncedCount: count,
      leads: this.getTenantLeads(cleanTenant)
    };
  }

  /**
   * Delete a lead by phone.
   */
  public deleteLead(tenantId: string, phone: string): boolean {
    const key = this.getLeadKey(tenantId, phone);
    const existed = this.leads.delete(key);
    if (existed) this.persistToDisk();
    return existed;
  }
}

export const crmLeadStore = new CrmLeadStore();
