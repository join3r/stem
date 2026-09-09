import { Alert } from 'react-native';

export function mailAction(action: () => Promise<unknown>): void {
  void action().catch((e) =>
    Alert.alert('Could not update mail', e instanceof Error ? e.message : String(e))
  );
}

export function chooseSnooze(
  snooze: (until: number | null) => Promise<unknown>,
  current?: number
): void {
  Alert.alert('Snooze mail', 'Move this conversation out of Inbox until later.', [
    { text: 'Cancel', style: 'cancel' },
    ...(current ? [{ text: 'Wake now', onPress: () => mailAction(() => snooze(null)) }] : []),
    { text: 'In one hour', onPress: () => mailAction(() => snooze(Date.now() + 60 * 60 * 1000)) },
    {
      text: 'Tomorrow morning',
      onPress: () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        mailAction(() => snooze(tomorrow.getTime()));
      }
    }
  ]);
}

export function confirmMailDelete(remove: () => Promise<unknown>): void {
  Alert.alert(
    'Delete this conversation?',
    'This deletes its messages and persona work on every device.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => mailAction(remove) }
    ]
  );
}
