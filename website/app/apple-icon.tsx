import { ImageResponse } from 'next/og';

export const size = {
  width: 180,
  height: 180,
};

export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        background: '#121317',
        borderRadius: 40,
      }}
    >
      <svg width="144" height="144" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10.25" stroke="#f8f9fc" strokeWidth="1.5" strokeOpacity="0.4" />
        <path
          d="M7.5 13.25 12 8.75l4.5 4.5"
          stroke="#f8f9fc"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7.5 17 12 12.5l4.5 4.5"
          stroke="#3279f9"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>,
    { ...size },
  );
}
