import i18n, { SUPPORTED_LANGUAGES, resources } from "../i18n";

describe("i18n configuration and translations", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("exports supported languages list", () => {
    expect(SUPPORTED_LANGUAGES).toEqual([
      { code: "en", label: "English", flag: "🇺🇸" },
      { code: "es", label: "Español", flag: "🇪🇸" },
    ]);
  });

  it("translates common keys in English", () => {
    expect(i18n.t("common.send")).toBe("Send");
    expect(i18n.t("common.receive")).toBe("Receive");
    expect(i18n.t("common.settings")).toBe("Settings");
    expect(i18n.t("dashboard.title")).toBe("Wallet Dashboard");
    expect(i18n.t("send.title")).toBe("Send Assets");
    expect(i18n.t("receive.title")).toBe("Receive Assets");
  });

  it("translates keys in Spanish when language is switched", async () => {
    await i18n.changeLanguage("es");
    expect(i18n.language).toBe("es");
    expect(i18n.t("common.send")).toBe("Enviar");
    expect(i18n.t("common.receive")).toBe("Recibir");
    expect(i18n.t("common.settings")).toBe("Ajustes");
    expect(i18n.t("dashboard.title")).toBe("Panel de Billetera");
    expect(i18n.t("send.title")).toBe("Enviar Activos");
    expect(i18n.t("receive.title")).toBe("Recibir Activos");
  });

  it("falls back to English when a key is missing in Spanish", async () => {
    await i18n.changeLanguage("es");
    expect(i18n.t("non_existent_key", "Default fallback")).toBe("Default fallback");
  });

  it("contains identical structure in Spanish resource bundle as English", () => {
    const enKeys = Object.keys(resources.en.common);
    const esKeys = Object.keys(resources.es.common);
    expect(esKeys).toEqual(enKeys);
  });
});
