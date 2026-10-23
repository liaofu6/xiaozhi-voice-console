<?php
/**
 * Thin single-file entry for Meting v1.5.11 (see Meting.php in this folder).
 *
 *   /api.php?server=netease|tencent|kugou|kuwo|baidu&type=search&id=<keyword>
 *   /api.php?server=netease&type=url&id=<song id>&br=320
 *   /api.php?server=netease&type=lyric&id=<song id>
 *   /api.php?server=netease&type=pic&id=<pic id>&size=300
 */

require_once __DIR__ . '/Meting.php';

use Metowolf\Meting;

$server = isset($_GET['server']) ? $_GET['server'] : 'netease';
$type   = isset($_GET['type'])   ? $_GET['type']   : 'search';
$id     = isset($_GET['id'])     ? $_GET['id']     : '';
$br     = isset($_GET['br'])     ? (int) $_GET['br'] : 320;

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$api = new Meting($server);
$api->format(true);
if (!empty($_GET['cookie'])) {
    $api->cookie($_GET['cookie']);
}
if (!empty($_GET['proxy'])) {
    $api->proxy($_GET['proxy']);
}

switch ($type) {
    case 'url':
        echo $api->url($id, $br);
        break;
    case 'pic':
        $size = isset($_GET['size']) ? (int) $_GET['size'] : 300;
        echo $api->pic($id, $size);
        break;
    case 'lyric':
        echo $api->lyric($id);
        break;
    case 'search':
    default:
        $option = array();
        if (isset($_GET['limit'])) {
            $option['limit'] = (int) $_GET['limit'];
        }
        if (isset($_GET['page'])) {
            $option['page'] = (int) $_GET['page'];
        }
        echo $api->search($id, $option);
        break;
}
