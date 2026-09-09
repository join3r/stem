import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MailWorkActivity, MailWorkGroup, MailWorkRun, Persona } from '@shared/types';
import { useTheme } from '../ui/theme';
import { mailName } from './list';
import { workDuration, workTimestamp } from './work';

const runLabel: Record<MailWorkRun['status'], string> = {
  running: 'Working', ok: 'Completed', failed: 'Failed', aborted: 'Stopped'
};
const activityLabel: Record<MailWorkActivity['status'], string> = {
  running: 'Running', ok: 'Done', error: 'Failed'
};

export function WorkSection({ groups, personas }: { groups: MailWorkGroup[]; personas: Persona[] }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<{ runId: string; activityId: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const runs = groups.flatMap((group) => group.runs);
  const running = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!expanded || !running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expanded, running]);
  if (!groups.length) return null;
  const selectedRun = runs.find((run) => run.id === selected?.runId);
  const selectedActivity = selectedRun?.activities.find((activity) => activity.id === selected?.activityId);
  const people = [...new Set(runs.map((run) => run.personaId))];
  const count = runs.reduce((sum, run) => sum + run.activities.length, 0);
  const failed = runs.some((run) => run.status === 'failed');
  const stopped = runs.some((run) => run.status === 'aborted');
  const summary = running ? 'Working' : failed ? 'Failed' : stopped ? 'Stopped' : 'Completed';
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.line, paddingTop: 8, gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`Work, ${summary}, ${count} activities`}
        onPress={() => setExpanded((value) => !value)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}
      >
        <Text style={{ color: theme.accent }}>{expanded ? '▾' : '▸'}</Text>
        <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>Work</Text>
        <Text style={{ color: failed ? theme.bad : running ? theme.accent : theme.dim, fontSize: 12 }}>
          {runs.length ? `${summary} · ${count} ${count === 1 ? 'activity' : 'activities'}` : 'History incomplete'}
        </Text>
      </Pressable>
      {expanded && (
        <View style={{ gap: 16 }}>
          {groups.some((group) => group.historical) && (
            <Text style={{ color: theme.dim, fontSize: 12 }}>Recovered from saved run history.</Text>
          )}
          {[...new Set(groups.flatMap((group) => group.gaps ?? []))].map((gap) => (
            <Text key={gap} selectable style={{ color: theme.warn, fontSize: 12 }}>{gap}</Text>
          ))}
          {people.map((personaId) => (
            <View key={personaId} style={{ gap: 12 }}>
              <Text style={{ color: theme.accent, fontWeight: '600' }}>{mailName(personas, personaId)}</Text>
              {runs.filter((run) => run.personaId === personaId).sort((a, b) => a.startedAt - b.startedAt).map((run, index) => (
                <View key={run.id} style={{ gap: 6, borderLeftWidth: 2, borderLeftColor: theme.line, paddingLeft: 12 }}>
                  <Text style={{ color: theme.text, fontSize: 13, fontWeight: '500' }}>
                    Run {index + 1} · {runLabel[run.status]}
                    {` · ${workDuration(run.startedAt, run.endedAt ?? (run.status === 'running' ? now : undefined))}`}
                  </Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{workTimestamp(run.startedAt)}</Text>
                  {run.error && <Text selectable style={{ color: theme.bad }}>{run.error}</Text>}
                  {!run.activities.length && <Text style={{ color: theme.dim, fontSize: 12 }}>
                    {run.status === 'running' ? 'Waiting for recorded activity…' : 'No activity records available.'}
                  </Text>}
                  {[...run.activities].sort((a, b) => a.at - b.at).map((activity) => (
                    <Pressable
                      key={activity.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${activity.label}, ${activityLabel[activity.status]}, show details`}
                      onPress={() => setSelected({ runId: run.id, activityId: activity.id })}
                      style={{ minHeight: 44, paddingVertical: 8, paddingLeft: activity.parentId ? 12 : 0, gap: 4 }}
                    >
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Text numberOfLines={2} style={{ color: theme.text, flex: 1 }}>{activity.label}</Text>
                        <Text style={{ color: theme.dim }}>›</Text>
                      </View>
                      <Text style={{ color: activity.status === 'error' ? theme.bad : theme.dim, fontSize: 12 }}>
                        {workTimestamp(activity.at, true)} · {activityLabel[activity.status]}
                        {activity.endedAt !== undefined ? ` · ${workDuration(activity.at, activity.endedAt)}` : ''}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </View>
          ))}
        </View>
      )}
      <Modal
        visible={!!selectedActivity}
        presentationStyle="fullScreen"
        animationType="slide"
        onRequestClose={() => setSelected(null)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: theme.line }}>
            <Text style={{ flex: 1, color: theme.text, fontWeight: '600', fontSize: 18 }}>Activity details</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close activity details" onPress={() => setSelected(null)} style={{ padding: 12 }}>
              <Text style={{ color: theme.accent }}>Done</Text>
            </Pressable>
          </View>
          {selectedActivity && selectedRun && (
            <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
              <Text selectable style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>{selectedActivity.label}</Text>
              <Text style={{ color: theme.dim }}>
                {mailName(personas, selectedRun.personaId)} · {activityLabel[selectedActivity.status]}{ '\n' }
                {workTimestamp(selectedActivity.at)}
              </Text>
              {selectedActivity.input !== undefined && (
                <View style={{ gap: 8 }}>
                  <Text style={{ color: theme.accent, fontWeight: '600' }}>Input</Text>
                  <Text selectable style={{ color: theme.text, fontFamily: 'Menlo', fontSize: 13 }}>{selectedActivity.input || '(empty)'}</Text>
                </View>
              )}
              {selectedActivity.output !== undefined && (
                <View style={{ gap: 8 }}>
                  <Text style={{ color: theme.accent, fontWeight: '600' }}>{selectedActivity.kind === 'progress' ? 'Progress' : 'Output'}</Text>
                  <Text selectable style={{ color: theme.text, fontFamily: selectedActivity.kind === 'tool' ? 'Menlo' : undefined, fontSize: 13 }}>{selectedActivity.output || '(empty)'}</Text>
                </View>
              )}
              {selectedActivity.input === undefined && selectedActivity.output === undefined && (
                <Text style={{ color: theme.dim }}>No additional details were recorded.</Text>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}
