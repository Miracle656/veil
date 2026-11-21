import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import {
  deleteRecipient,
  listRecipients,
  loadSavedRecipients,
  saveRecipient,
  type RecipientKind,
  type SavedRecipient,
} from '../lib/savedRecipients';

export function useSavedRecipients<K extends RecipientKind>(kind: K) {
  const [all, setAll] = useState<SavedRecipient[]>([]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void loadSavedRecipients()
        .then((list) => {
          if (active) setAll(list);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, [])
  );

  const save = useCallback(async (recipient: Extract<SavedRecipient, { kind: K }>) => {
    const list = await saveRecipient(recipient);
    setAll(list);
  }, []);

  const remove = useCallback(async (recipient: Extract<SavedRecipient, { kind: K }>) => {
    const list = await deleteRecipient(recipient);
    setAll(list);
  }, []);

  return { recipients: listRecipients(all, kind), save, remove };
}
