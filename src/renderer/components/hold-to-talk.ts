export interface HoldToTalkActions {
  start: () => Promise<string | undefined>;
  stop: (sessionId: string) => Promise<void>;
}

interface ActiveHold {
  released: boolean;
  sessionId?: string;
  stop: HoldToTalkActions["stop"];
}

export interface HoldToTalkController {
  press: (actions: HoldToTalkActions) => Promise<void>;
  release: () => Promise<void>;
}

export function createHoldToTalkController(
  onError: (error: unknown) => void = (error) => {
    console.error("Failed to handle hold-to-talk input:", error);
  },
): HoldToTalkController {
  let activeHold: ActiveHold | undefined;

  return {
    async press(actions) {
      if (activeHold) return;
      const hold: ActiveHold = {
        released: false,
        stop: actions.stop,
      };
      activeHold = hold;

      try {
        const sessionId = await actions.start();
        if (!sessionId) {
          if (activeHold === hold) activeHold = undefined;
          return;
        }
        if (hold.released || activeHold !== hold) {
          await actions.stop(sessionId);
          return;
        }
        hold.sessionId = sessionId;
      } catch (error) {
        if (activeHold === hold) activeHold = undefined;
        onError(error);
      }
    },

    async release() {
      const hold = activeHold;
      if (!hold) return;
      activeHold = undefined;
      hold.released = true;
      if (!hold.sessionId) return;
      try {
        await hold.stop(hold.sessionId);
      } catch (error) {
        onError(error);
      }
    },
  };
}
