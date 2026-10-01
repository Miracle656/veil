"use client";

import React from "react";
import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "../lib/i18n";
import { Globe } from "lucide-react";

interface LanguageSwitcherProps {
  className?: string;
  showIcon?: boolean;
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({
  className = "",
  showIcon = true,
}) => {
  const { i18n, t } = useTranslation();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    i18n.changeLanguage(newLang);
    if (typeof window !== "undefined") {
      localStorage.setItem("veil_language", newLang);
    }
  };

  const currentLang = i18n.language?.startsWith("es") ? "es" : "en";

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showIcon && <Globe className="w-4 h-4 text-zinc-400" aria-hidden="true" />}
      <select
        value={currentLang}
        onChange={handleLanguageChange}
        aria-label={t("settings.select_language", "Select Language")}
        className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-blue-500 focus:outline-none cursor-pointer"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.flag} {lang.label}
          </option>
        ))}
      </select>
    </div>
  );
};
