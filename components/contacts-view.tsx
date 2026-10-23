"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Building2,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";

type Contact = {
  id: string;
  resourceName: string;
  name: string;
  email: string;
  phone?: string;
  organization?: string;
  jobTitle?: string;
  photoUrl?: string;
  notes: string;
  tags: string[];
  relationshipScore: number;
  source: "google" | "manual";
  createdAt: string;
  updatedAt: string;
};

type ContactsResponse = {
  ok: boolean;
  contacts?: Contact[];
  contact?: Contact;
  googleConnected?: boolean;
  synced?: boolean;
  syncWarning?: string;
  deleted?: boolean;
  error?: string;
};

type ContactForm = {
  name: string;
  email: string;
  phone: string;
  organization: string;
  jobTitle: string;
  relationshipScore: string;
  tags: string;
  notes: string;
};

const EMPTY_FORM: ContactForm = {
  name: "",
  email: "",
  phone: "",
  organization: "",
  jobTitle: "",
  relationshipScore: "80",
  tags: "",
  notes: "",
};

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function tagsFromInput(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export function ContactsView({
  onNotify,
  onContactsCountChange,
}: {
  onNotify?: (message: string, tone?: "success" | "error" | "info") => void;
  onContactsCountChange?: (count: number) => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [score, setScore] = useState("80");
  const [savingNotes, setSavingNotes] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);

  const loadContacts = useCallback(async (sync = false) => {
    if (sync) setSyncing(true);
    else setLoading(true);
    setError("");
    setSyncWarning("");
    try {
      const response = await fetch(`/api/contacts${sync ? "?sync=true" : ""}`, { cache: "no-store" });
      const result = await readApiResponse<ContactsResponse>(response);
      if (!response.ok || !result.ok || !Array.isArray(result.contacts)) {
        throw new Error(result.error ?? "Contacts could not be loaded.");
      }
      setContacts(result.contacts);
      setGoogleConnected(Boolean(result.googleConnected));
      setSyncWarning(result.syncWarning ?? "");
      onContactsCountChange?.(result.contacts.length);
      if (sync) {
        onNotify?.(
          result.syncWarning
            ? "Saved contacts loaded; Google sync needs attention."
            : result.synced
              ? "Google Contacts synced."
              : "Saved contacts refreshed.",
          result.syncWarning ? "info" : "success",
        );
      }
    } catch (loadError) {
      const message = apiErrorMessage(loadError, "Contacts could not be loaded.");
      setError(message);
      if (sync) onNotify?.(message, "error");
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [onContactsCountChange, onNotify]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  useEffect(() => {
    if (!selected) return;
    setNotes(selected.notes);
    setTags(selected.tags.join(", "));
    setScore(String(selected.relationshipScore));
  }, [selected]);

  const filteredContacts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return contacts;
    return contacts.filter((contact) => [
      contact.name,
      contact.email,
      contact.organization ?? "",
      contact.jobTitle ?? "",
      ...contact.tags,
    ].some((value) => value.toLowerCase().includes(normalizedQuery)));
  }, [contacts, query]);

  async function createContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          organization: form.organization || undefined,
          jobTitle: form.jobTitle || undefined,
          relationshipScore: Number(form.relationshipScore),
          tags: tagsFromInput(form.tags),
          notes: form.notes,
        }),
      });
      const result = await readApiResponse<ContactsResponse>(response);
      if (!response.ok || !result.ok || !result.contact) {
        throw new Error(result.error ?? "Contact could not be saved.");
      }
      setContacts((current) => [result.contact!, ...current]);
      onContactsCountChange?.(contacts.length + 1);
      setForm(EMPTY_FORM);
      setAddOpen(false);
      onNotify?.("Contact saved.");
    } catch (saveError) {
      onNotify?.(apiErrorMessage(saveError, "Contact could not be saved."), "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveContactNotes() {
    if (!selected) return;
    setSavingNotes(true);
    try {
      const response = await fetch("/api/contacts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceName: selected.resourceName,
          notes,
          tags: tagsFromInput(tags),
          relationshipScore: Number(score),
        }),
      });
      const result = await readApiResponse<ContactsResponse>(response);
      if (!response.ok || !result.ok || !result.contact) {
        throw new Error(result.error ?? "Contact details could not be updated.");
      }
      setContacts((current) => current.map((contact) =>
        contact.resourceName === result.contact!.resourceName ? result.contact! : contact));
      setSelected(result.contact);
      onNotify?.("Contact intelligence saved.");
    } catch (saveError) {
      onNotify?.(apiErrorMessage(saveError, "Contact details could not be updated."), "error");
    } finally {
      setSavingNotes(false);
    }
  }

  async function deleteContact() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch("/api/contacts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceName: deleteTarget.resourceName }),
      });
      const result = await readApiResponse<ContactsResponse>(response);
      if (!response.ok || !result.ok || !result.deleted) {
        throw new Error(result.error ?? "Contact could not be deleted.");
      }
      const remaining = contacts.filter((contact) => contact.resourceName !== deleteTarget.resourceName);
      setContacts(remaining);
      onContactsCountChange?.(remaining.length);
      if (selected?.resourceName === deleteTarget.resourceName) setSelected(null);
      setDeleteTarget(null);
      onNotify?.("Contact deleted.");
    } catch (deleteError) {
      onNotify?.(apiErrorMessage(deleteError, "Contact could not be deleted."), "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="contacts-view">
      <div className="panel contacts-panel">
        <div className="panel-heading">
          <div>
            <span className="insight-eyebrow">PEOPLE · RELATIONSHIP INTELLIGENCE</span>
            <h2>Contacts</h2>
            <p>MongoDB is the permanent source of truth for your workspace contacts.</p>
          </div>
          <div className="contacts-toolbar">
            <button className="refresh-button" type="button" onClick={() => void loadContacts(true)} disabled={syncing}>
              <RefreshCw size={14} className={syncing ? "spin" : ""} />
              {syncing ? "Syncing…" : "Sync Google Contacts"}
            </button>
            <button className="contacts-primary-button" type="button" onClick={() => setAddOpen(true)}>
              <Plus size={14} /> Add Contact
            </button>
          </div>
        </div>
        <div className="contacts-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, company, role, or tag"
            aria-label="Search contacts"
          />
          <span>{contacts.length} saved</span>
        </div>
        {!googleConnected && (
          <p className="contacts-hint">Connect Google in Integrations to sync People contacts. Manual contacts are saved here permanently.</p>
        )}
        {syncWarning && <p className="contacts-warning" role="status">{syncWarning}</p>}
        {error && <p className="contacts-error" role="alert">{error}</p>}
      </div>

      {loading ? (
        <div className="panel contacts-empty" role="status">Loading saved contacts…</div>
      ) : filteredContacts.length === 0 ? (
        <div className="panel contacts-empty">
          <UserRound size={22} />
          <strong>{query ? "No matching contacts" : "No contacts saved yet"}</strong>
          <p>{query ? "Try a different search." : "Add a contact or sync Google Contacts to get started."}</p>
        </div>
      ) : (
        <div className="contacts-grid">
          {filteredContacts.map((contact) => {
            const photoUrl = safeHttpsUrl(contact.photoUrl);
            return (
              <article className="contact-card" key={contact.resourceName}>
                <button
                  className="contact-card-main"
                  type="button"
                  onClick={() => setSelected(contact)}
                  aria-label={`View contact intelligence for ${contact.name}`}
                >
                  <span className="contact-avatar">
                    {photoUrl
                      ? <img src={photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      : contact.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="contact-card-copy">
                    <strong>{contact.name}</strong>
                    <span>{contact.jobTitle || contact.organization || "Workspace contact"}</span>
                  </span>
                  <span className="contact-score"><Star size={12} /> {contact.relationshipScore}</span>
                </button>
                <div className="contact-card-details">
                  <span><Mail size={13} />{contact.email}</span>
                  {contact.organization && <span><Building2 size={13} />{contact.organization}</span>}
                </div>
                <div className="contact-card-footer">
                  <span className={`contact-source source-${contact.source}`}>{contact.source === "google" ? "Google" : "Manual"}</span>
                  {contact.tags.slice(0, 3).map((tag) => <span className="contact-tag" key={tag}>{tag}</span>)}
                  <button type="button" className="icon-action danger" onClick={() => setDeleteTarget(contact)} aria-label={`Delete ${contact.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="contact-drawer-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}>
          <aside className="contact-drawer" role="dialog" aria-modal="true" aria-labelledby="contact-drawer-title">
            <div className="contact-drawer-heading">
              <div><span className="insight-eyebrow">CONTACT INTELLIGENCE</span><h2 id="contact-drawer-title">{selected.name}</h2></div>
              <button className="icon-action" type="button" onClick={() => setSelected(null)} aria-label="Close contact details"><X size={17} /></button>
            </div>
            <p className="contact-role">{selected.jobTitle || "Role not provided"}{selected.organization ? ` · ${selected.organization}` : ""}</p>
            <div className="contact-badges">
              <span className={`contact-source source-${selected.source}`}>{selected.source === "google" ? "Google" : "Manual"}</span>
              <span className="contact-score"><Star size={12} /> {selected.relationshipScore}% relationship score</span>
            </div>
            <div className="contact-drawer-details">
              <a href={`mailto:${encodeURIComponent(selected.email)}`}><Mail size={14} />{selected.email}</a>
              {selected.phone && <a href={`tel:${encodeURIComponent(selected.phone)}`}><Phone size={14} />{selected.phone}</a>}
            </div>
            <label className="workspace-field"><span>Relationship score · {score}</span>
              <input type="range" min="0" max="100" value={score} onChange={(event) => setScore(event.target.value)} />
            </label>
            <label className="workspace-field"><span>Tags</span>
              <input value={tags} onChange={(event) => setTags(event.target.value)} maxLength={1_100} placeholder="friend, work, mentor" />
            </label>
            <label className="workspace-field"><span>Private notes</span>
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4_000} rows={7} placeholder="Add relationship context…" />
            </label>
            <button className="contacts-primary-button full-width" type="button" onClick={() => void saveContactNotes()} disabled={savingNotes}>
              {savingNotes ? "Saving…" : "Save contact intelligence"}
            </button>
          </aside>
        </div>
      )}

      {addOpen && (
        <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) setAddOpen(false);
        }}>
          <section className="confirm-dialog contact-form-dialog" role="dialog" aria-modal="true" aria-labelledby="add-contact-title">
            <div className="contact-dialog-heading"><div><span className="insight-eyebrow">WORKSPACE DIRECTORY</span><h2 id="add-contact-title">Add Contact</h2></div>
              <button className="icon-action" type="button" onClick={() => setAddOpen(false)} aria-label="Close add contact form"><X size={17} /></button>
            </div>
            <form onSubmit={(event) => void createContact(event)}>
              <label className="workspace-field"><span>Name *</span><input required maxLength={200} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="workspace-field"><span>Email *</span><input type="email" required maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
              <div className="contacts-form-grid">
                <label className="workspace-field"><span>Phone</span><input maxLength={60} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
                <label className="workspace-field"><span>Organization</span><input maxLength={200} value={form.organization} onChange={(event) => setForm({ ...form, organization: event.target.value })} /></label>
                <label className="workspace-field"><span>Job title</span><input maxLength={200} value={form.jobTitle} onChange={(event) => setForm({ ...form, jobTitle: event.target.value })} /></label>
                <label className="workspace-field"><span>Relationship score</span><input type="number" min="0" max="100" value={form.relationshipScore} onChange={(event) => setForm({ ...form, relationshipScore: event.target.value })} /></label>
              </div>
              <label className="workspace-field"><span>Tags · comma separated</span><input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="friend, work" /></label>
              <label className="workspace-field"><span>Private notes</span><textarea rows={4} maxLength={4_000} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
              <div className="contact-dialog-actions">
                <button type="button" className="create-cancel" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</button>
                <button type="submit" className="contacts-primary-button" disabled={saving}>{saving ? "Saving…" : "Save Contact"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="confirm-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setDeleteTarget(null);
        }}>
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-contact-title" aria-describedby="delete-contact-description">
            <span className="confirm-icon danger"><Trash2 size={19} /></span>
            <h2 id="delete-contact-title">Delete contact?</h2>
            <p id="delete-contact-description">Delete {deleteTarget.name} from this workspace and, when available, Google Contacts.</p>
            <div className="confirm-actions">
              <button type="button" className="create-cancel" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</button>
              <button type="button" className="confirm-delete" onClick={() => void deleteContact()} disabled={deleting}>{deleting ? "Deleting…" : "Delete contact"}</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
