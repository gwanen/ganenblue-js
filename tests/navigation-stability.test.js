import { jest, describe, test, expect, beforeEach } from "@jest/globals";
// Mock dependencies
jest.unstable_mockModule("../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
  },
  createScopedLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.unstable_mockModule("../src/utils/config.js", () => ({
  default: {
    get: jest.fn((key) => {
      if (key === "navigation.footerReload") return ".btn-treasure-footer-reload";
      return null;
    }),
  },
}));

// We must import the modules AFTER mocking
const { default: PageController } = await import("../src/core/page-controller.js");

describe("PageController Navigation & Stability", () => {
  let controller;
  let mockPage;

  beforeEach(() => {
    mockPage = {
      on: jest.fn(),
      off: jest.fn(),
      target: jest.fn(() => ({
        createCDPSession: jest.fn(() => ({
          send: jest.fn(),
          detach: jest.fn(),
        })),
      })),
      isClosed: jest.fn(() => false),
      setRequestInterception: jest.fn().mockResolvedValue(true),
      goto: jest.fn(),
      reload: jest.fn(),
      click: jest.fn(),
      waitForFunction: jest.fn(),
      evaluate: jest.fn(),
      mainFrame: jest.fn(() => ({
        isDetached: jest.fn(() => false),
      })),
    };
    const mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn(() => mockLogger),
    };
    controller = new PageController(mockPage, mockLogger); 
  });

  test("reloadHard() performs a full browser reload", async () => {
    await controller.reloadHard();
    expect(mockPage.reload).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: "networkidle2" }),
    );
  });

  test("reloadSoft() clicks footer button if it exists", async () => {
    // Mock elementExists to return true for the button
    controller.elementExists = jest.fn().mockResolvedValue(true);
    controller.waitForSPAUpdate = jest.fn().mockResolvedValue(true);
    controller.waitForFrameStable = jest.fn().mockResolvedValue(true);

    await controller.reloadSoft();
    expect(mockPage.click).toHaveBeenCalledWith(".btn-treasure-footer-reload");
  });

  test("reloadSoft() falls back to page.reload if button missing", async () => {
    controller.elementExists = jest.fn().mockResolvedValue(false);
    controller.waitForFrameStable = jest.fn().mockResolvedValue(true);

    await controller.reloadSoft();
    expect(mockPage.reload).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  test("handleDetachedFrame() sets state and throws special error", () => {
    const error = new Error("detached Frame");
    expect(() => controller.handleDetachedFrame(error)).toThrow("DETACHED_FRAME");
    expect(controller.detachedState).toBe(true);
  });

  test("goto() triggers safety stop on detached frame error", async () => {
    const detachedError = new Error("Protocol error (Page.navigate): Target closed. (detached Frame)");
    mockPage.goto.mockRejectedValue(detachedError);
    
    await expect(controller.goto("http://test.com")).rejects.toThrow("DETACHED_FRAME");
  });

  test("gotoSPA() with clickSelector triggers a click", async () => {
    controller.waitForSPAUpdate = jest.fn().mockResolvedValue(true);
    await controller.gotoSPA("http://test.com#quest", { clickSelector: ".nav-btn" });
    
    expect(mockPage.click).toHaveBeenCalledWith(".nav-btn");
  });
});
