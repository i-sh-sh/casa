import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { AsyncForm, Field, Sheet } from '../../ui/kit.js';

/**
 * «איך לקרוא לך», and the home's name for its owner.
 *
 * Both were asked once, at sign-up, and then printed every day — in «מי שילם»,
 * in «בינינו», at the top of this screen — with no way back to them.
 */
export function ProfileSheet({ onClose }: { onClose: () => void }) {
  const { user, refresh } = useSession();
  const isOwner = user?.role === 'owner';
  const [name, setName] = useState(user?.display_name ?? user?.name ?? '');
  const [home, setHome] = useState(user?.household_name ?? '');

  return (
    <Sheet title="אנחנו" onClose={onClose}>
      <AsyncForm
        submitLabel="שמירה"
        disabled={!name.trim() || (isOwner && !home.trim())}
        onSubmit={async () => {
          const body: Record<string, string> = {};
          if (name.trim() !== (user?.display_name ?? '')) body['display_name'] = name.trim();
          if (isOwner && home.trim() !== (user?.household_name ?? '')) body['household_name'] = home.trim();
          if (Object.keys(body).length > 0) {
            await api.post('/auth/profile', body);
            await refresh();
          }
          onClose();
        }}
      >
        <Field label="איך לקרוא לך">
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <p className="meta" style={{ marginTop: 'calc(-1 * var(--s2))', marginBottom: 'var(--s4)' }}>
          כך תופיעו ב«מי שילם» וב«בינינו».
        </p>
        {isOwner && (
          <Field label="שם הבית">
            <input className="input" value={home} maxLength={80} onChange={(e) => setHome(e.target.value)} />
          </Field>
        )}
      </AsyncForm>
    </Sheet>
  );
}
