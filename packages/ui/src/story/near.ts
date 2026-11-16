import { createContext, useContext } from 'react';

/**
 * Whether the chapter is within about a screen of the viewport. Charts,
 * maps and tables mount only then: each map holds two WebGL contexts, and
 * browsers cap a page at about sixteen.
 */
export const ChapterNearContext = createContext(true);

export const useChapterNear = () => useContext(ChapterNearContext);
