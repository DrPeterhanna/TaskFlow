import React, { createContext, useContext } from 'react';
import { lightTheme, type Theme } from './tokens';

const Ctx = createContext<Theme>(lightTheme);
export const ThemeProvider = Ctx.Provider;
export const useTheme = (): Theme => useContext(Ctx);
