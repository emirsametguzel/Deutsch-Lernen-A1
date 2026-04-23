<?php
declare(strict_types=1);

// Simple server-side TTS proxy for InfinityFree.
// Streams MP3 audio from Google Translate TTS endpoint.
//
// Usage:
//   /tts.php?q=Guten%20Tag&tl=de-DE
//
// Notes:
// - No API key required, but upstream availability can change.
// - Keep text short to reduce failures.

header('X-Content-Type-Options: nosniff');

$q = isset($_GET['q']) ? (string)$_GET['q'] : '';
$tl = isset($_GET['tl']) ? (string)$_GET['tl'] : 'de-DE';

$q = trim($q);
if ($q === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Missing q';
    exit;
}

// Basic limits and cleanup
$q = preg_replace('/\s+/u', ' ', $q);
if (mb_strlen($q, 'UTF-8') > 180) {
    $q = mb_substr($q, 0, 180, 'UTF-8');
}

// Allow only a safe-ish language pattern (e.g. de, de-DE)
if (!preg_match('/^[a-z]{2}(-[A-Z]{2})?$/', $tl)) {
    $tl = 'de-DE';
}

$encoded = rawurlencode($q);

// Primary endpoint
$url = 'https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=' . rawurlencode($tl) . '&q=' . $encoded;

function fetch_bytes(string $url): array {
    // returns [status_code, bytes]
    $ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_HTTPHEADER => [
                'User-Agent: ' . $ua,
                'Accept: audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
                'Referer: https://translate.google.com/',
            ],
        ]);
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$code, is_string($body) ? $body : ''];
    }

    // Fallback: file_get_contents
    $context = stream_context_create([
        'http' => [
            'method' => 'GET',
            'timeout' => 12,
            'header' => "User-Agent: {$ua}\r\nAccept: audio/mpeg,audio/*;q=0.9,*/*;q=0.8\r\nReferer: https://translate.google.com/\r\n",
        ],
    ]);
    $body = @file_get_contents($url, false, $context);
    $code = 0;
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $code = (int)$m[1];
                break;
            }
        }
    }
    return [$code, is_string($body) ? $body : ''];
}

[$code, $bytes] = fetch_bytes($url);
if ($code < 200 || $code >= 300 || $bytes === '') {
    // Secondary endpoint
    $url2 = 'https://translate.google.com/translate_tts?client=tw-ob&ie=UTF-8&tl=' . rawurlencode($tl) . '&q=' . $encoded;
    [$code2, $bytes2] = fetch_bytes($url2);
    $code = $code2;
    $bytes = $bytes2;
}

if ($code < 200 || $code >= 300 || $bytes === '') {
    http_response_code(502);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Upstream TTS failed';
    exit;
}

header('Content-Type: audio/mpeg');
header('Cache-Control: public, max-age=86400');
echo $bytes;
