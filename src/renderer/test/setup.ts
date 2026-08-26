if (typeof window !== "undefined") {
  class TestResizeObserver {
    disconnect(): void {}

    observe(): void {}

    unobserve(): void {}
  }

  class TestPointerEvent extends MouseEvent {
    readonly height: number;
    readonly isPrimary: boolean;
    readonly pointerId: number;
    readonly pointerType: string;
    readonly pressure: number;
    readonly tangentialPressure: number;
    readonly tiltX: number;
    readonly tiltY: number;
    readonly twist: number;
    readonly width: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.height = init.height ?? 1;
      this.isPrimary = init.isPrimary ?? false;
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
      this.pressure = init.pressure ?? 0;
      this.tangentialPressure = init.tangentialPressure ?? 0;
      this.tiltX = init.tiltX ?? 0;
      this.tiltY = init.tiltY ?? 0;
      this.twist = init.twist ?? 0;
      this.width = init.width ?? 1;
    }
  }

  const noOp = (): void => {};

  if (!("ResizeObserver" in globalThis)) {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
      writable: true,
    });
  }

  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: TestPointerEvent,
      writable: true,
    });
    Object.defineProperty(globalThis, "PointerEvent", {
      configurable: true,
      value: TestPointerEvent,
      writable: true,
    });
  }

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      addEventListener: noOp,
      addListener: noOp,
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: noOp,
      removeListener: noOp,
    }),
    writable: true,
  });

  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: noOp,
    writable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: noOp,
    writable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: noOp,
    writable: true,
  });

  if (!("hasPointerCapture" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
      writable: true,
    });
  }
  if (!("setPointerCapture" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: noOp,
      writable: true,
    });
  }
  if (!("releasePointerCapture" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "releasePointerCapture", {
      configurable: true,
      value: noOp,
      writable: true,
    });
  }

  if (!("inert" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "inert", {
      configurable: true,
      get(this: HTMLElement): boolean {
        return this.hasAttribute("inert");
      },
      set(this: HTMLElement, value: boolean) {
        if (value) this.setAttribute("inert", "");
        else this.removeAttribute("inert");
      },
    });
  }
}

export {};
