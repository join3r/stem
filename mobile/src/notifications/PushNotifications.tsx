// Push, mounted: register this phone when it has a server, and take the user
// where a tapped notification points.
//
// Renders nothing. It is a component rather than a hook called from a screen for
// the same reason <ApprovalSheet> is: a notification can arrive whatever is on
// screen, including before there is a screen at all, so the thing that listens
// has to live above the router and outlive every route.
//
// THREE MOMENTS, and the third is the one that is easy to get wrong:
//
//   registration   after pairing, never before. The permission prompt is iOS's
//                  one shot, so it is spent on somebody who has just connected a
//                  phone to their Stem and can see what it is for — not on the
//                  first launch of an app they have not set up yet.
//   rotation       iOS can replace a device token while the app runs. The
//                  listener re-registers immediately; the server's handler is
//                  idempotent, so this is a call, not a protocol.
//   a cold-start   the tap that LAUNCHED the app has already happened by the time
//   tap            any of this mounts, and there is no event left to receive.
//                  getLastNotificationResponse() is that tap, and it is cleared
//                  once acted on so a later remount cannot navigate a second time.
//
// Navigation waits for two things: a navigator that exists (a route pushed before
// the root layout has mounted is dropped) and a pairing (an unpaired app belongs
// on /pair, and sending it to a thread it cannot load would be a white screen).
// A route that arrives early is held, not lost.
//
// No setNotificationHandler, deliberately: a notification arriving while the app
// is open should NOT raise a banner over the very screen that is already showing
// the thing live over SSE. iOS's default for a foregrounded app is to stay quiet,
// which is the behaviour we want and the code we do not have to write.

import { useRootNavigationState, useRouter } from 'expo-router';
import {
  addNotificationResponseReceivedListener,
  addPushTokenListener,
  clearLastNotificationResponse,
  getLastNotificationResponse
} from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { useTransport } from '../transport/provider';
import { expoPushPlatform } from './expo';
import { registerForPush } from './register';
import { routeForNotification, type NotificationRoute } from './route';

const log = (message: string, meta?: Record<string, unknown>): void =>
  console.log(`[push] ${message}`, meta ?? '');

export function PushNotifications(): null {
  const { connection, status } = useTransport();
  const router = useRouter();
  // `key` is set once the root navigator has mounted. Until then router.push()
  // goes nowhere at all, which is precisely the cold-start case.
  const navigationKey = useRootNavigationState()?.key;
  const ready = !!navigationKey && status.paired;

  /** A tap that arrived before there was anywhere to send it. */
  const held = useRef<NotificationRoute | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const go = useCallback(
    (route: NotificationRoute) => {
      if (route.screen === 'mail') {
        router.push({ pathname: '/mail/[id]', params: { id: route.conversationId } });
      } else if (route.screen === 'thread') {
        router.push({ pathname: '/thread/[id]', params: { id: route.threadId } });
      } else {
        router.navigate('/');
      }
    },
    [router]
  );

  const follow = useCallback(
    (route: NotificationRoute | null) => {
      // Null means the payload was not one of ours, or named nothing to open.
      // Staying put is the answer: a notification must never move somebody who
      // is in the middle of reading.
      if (!route) return;
      if (readyRef.current) go(route);
      else held.current = route;
    },
    [go]
  );

  useEffect(() => {
    if (!ready || !held.current) return;
    const route = held.current;
    held.current = null;
    go(route);
  }, [go, ready]);

  // ---- registration ----

  useEffect(() => {
    if (!status.paired) return;
    let live = true;
    const send = (token: string): Promise<void> => connection.rpc('devices:registerPush', token, 'ios');

    void registerForPush({ paired: true, platform: expoPushPlatform, register: send, log }).then(
      (outcome) => {
        if (live) log(`push registration: ${outcome}`);
      }
    );

    // A rotation is rare and silent, and a phone whose token has moved is a phone
    // that simply stops being woken — so the listener matters more than its
    // frequency suggests.
    let subscription: { remove(): void } | null = null;
    try {
      subscription = addPushTokenListener((token) => {
        if (typeof token.data !== 'string' || !token.data) return;
        void send(token.data.toLowerCase()).catch((e) =>
          log('could not re-register a rotated token', { error: String((e as Error)?.message ?? e) })
        );
      });
    } catch (e) {
      // Expo Go has no token to rotate. See the EXPO GO note in ./register.ts.
      log('token rotation is not observable in this build', {
        error: String((e as Error)?.message ?? e)
      });
    }
    return () => {
      live = false;
      subscription?.remove();
    };
  }, [connection, status.paired]);

  // ---- taps ----

  useEffect(() => {
    const subscription = addNotificationResponseReceivedListener((response) =>
      follow(routeForNotification(response))
    );
    const cold = getLastNotificationResponse();
    if (cold) {
      follow(routeForNotification(cold));
      // Acted on, so it must not be acted on again — this survives across mounts.
      clearLastNotificationResponse();
    }
    return () => subscription.remove();
  }, [follow]);

  return null;
}
