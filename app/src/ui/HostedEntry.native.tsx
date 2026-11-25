import React from 'react';
import type { Locale } from '../i18n';
import { HostedApp } from './HostedApp';
export const hostedAvailable = true;
export function HostedEntry({ locale }: { locale: Locale }) { return <HostedApp locale={locale} />; }
