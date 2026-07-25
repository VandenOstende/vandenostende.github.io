// ESM shim exposing the UMD React global (loaded via classic <script>).
const R = window.React;
export default R;
export const {
  useReducer, useRef, useState, useEffect, useCallback, useMemo,
  createElement, Fragment,
} = R;
