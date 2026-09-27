"use client";

import React, { useEffect } from "react";
import { I18nextProvider } from "react-i18next";
import i18n from "../lib/i18n";

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    // Sync html lang attribute whenever language changes
    const updateLang = (lng: string) => {
      if (typeof document !== "undefined") {
        document.documentElement.lang = lng;
      }
    };
    i18n.on("languageChanged", updateLang);
    updateLang(i18n.language || "en");

    return () => {
      i18n.off("languageChanged", updateLang);
    };
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
};
