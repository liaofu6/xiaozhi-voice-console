<?php
/**
 * Router for the PHP built-in server (`php -S 127.0.0.1:3300 -t <dir> <this> -t`).
 * Meting.php only defines a class, so the classic URL `/Meting.php?server=...`
 * must be dispatched to api.php. Everything else is served statically.
 */

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/Meting.php' || $path === '/Meting.php/') {
    require __DIR__ . '/api.php';
    return true;
}

return false;
