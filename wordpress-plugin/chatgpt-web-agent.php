<?php
/**
 * Plugin Name: ChatGPT Web Agent
 * Description: Secure REST bridge for ChatGPT Web Agent to inspect and manage WordPress pages, Gutenberg blocks, media, and agent-owned CSS.
 * Version: 0.2.0
 * Author: ChatGPT Web Agent
 */

if (!defined('ABSPATH')) {
    exit;
}

final class ChatGPT_Web_Agent {
    const OPTION_TOKEN = 'chatgpt_web_agent_token';
    const OPTION_CSS = 'chatgpt_web_agent_css';
    const REST_NS = 'chatgpt-web-agent/v1';
    const MAX_CSS_BYTES = 262144;

    public static function init() {
        register_activation_hook(__FILE__, [__CLASS__, 'activate']);
        add_action('rest_api_init', [__CLASS__, 'register_routes']);
        add_action('admin_menu', [__CLASS__, 'admin_menu']);
        add_action('admin_post_chatgpt_web_agent_regenerate_token', [__CLASS__, 'regenerate_token']);
        add_action('wp_head', [__CLASS__, 'render_agent_css'], 999);
    }

    public static function activate() {
        if (!get_option(self::OPTION_TOKEN)) {
            update_option(self::OPTION_TOKEN, wp_generate_password(48, false, false), false);
        }
    }

    public static function authorize(WP_REST_Request $request) {
        $stored = (string) get_option(self::OPTION_TOKEN, '');
        $provided = (string) $request->get_header('x-chatgpt-web-agent-token');
        if (!$stored || !$provided || !hash_equals($stored, $provided)) {
            return new WP_Error('chatgpt_web_agent_unauthorized', 'Invalid ChatGPT Web Agent token.', ['status' => 401]);
        }
        return true;
    }

    public static function register_routes() {
        register_rest_route(self::REST_NS, '/site', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'site_info'],
            'permission_callback' => [__CLASS__, 'authorize'],
        ]);

        register_rest_route(self::REST_NS, '/pages', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'list_pages'],
                'permission_callback' => [__CLASS__, 'authorize'],
            ],
            [
                'methods' => 'POST',
                'callback' => [__CLASS__, 'create_page'],
                'permission_callback' => [__CLASS__, 'authorize'],
            ],
        ]);

        register_rest_route(self::REST_NS, '/pages/(?P<id>\d+)', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_page'],
                'permission_callback' => [__CLASS__, 'authorize'],
            ],
            [
                'methods' => ['PATCH', 'PUT'],
                'callback' => [__CLASS__, 'update_page'],
                'permission_callback' => [__CLASS__, 'authorize'],
            ],
        ]);

        register_rest_route(self::REST_NS, '/pages/(?P<id>\d+)/blocks', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'get_page_blocks'],
            'permission_callback' => [__CLASS__, 'authorize'],
        ]);

        register_rest_route(self::REST_NS, '/media', [
            'methods' => 'GET',
            'callback' => [__CLASS__, 'list_media'],
            'permission_callback' => [__CLASS__, 'authorize'],
        ]);

        register_rest_route(self::REST_NS, '/media/import', [
            'methods' => 'POST',
            'callback' => [__CLASS__, 'import_media'],
            'permission_callback' => [__CLASS__, 'authorize'],
        ]);

        register_rest_route(self::REST_NS, '/styles/agent-css', [
            [
                'methods' => 'GET',
                'callback' => [__CLASS__, 'get_agent_css'],
                'permission_callback' => [__CLASS__, 'authorize'],
            ],
            [
                'methods' => ['PUT', 'PATCH'],
                'callback' => [__CLASS__, 'update_agent_css'],
                'permission_callback' => [__CLASS__, 'authorize'],
            ],
        ]);
    }

    public static function site_info() {
        $theme = wp_get_theme();
        $registered_blocks = class_exists('WP_Block_Type_Registry')
            ? array_keys(WP_Block_Type_Registry::get_instance()->get_all_registered())
            : [];

        return rest_ensure_response([
            'name' => get_bloginfo('name'),
            'url' => home_url('/'),
            'rest_url' => rest_url(),
            'wordpress_version' => get_bloginfo('version'),
            'plugin_version' => '0.2.0',
            'theme' => [
                'name' => $theme->get('Name'),
                'version' => $theme->get('Version'),
                'stylesheet' => $theme->get_stylesheet(),
                'template' => $theme->get_template(),
            ],
            'front_page_id' => (int) get_option('page_on_front'),
            'show_on_front' => get_option('show_on_front'),
            'registered_blocks' => array_values($registered_blocks),
            'features' => [
                'pages' => true,
                'gutenberg_blocks' => true,
                'media_import' => true,
                'agent_css' => true,
            ],
        ]);
    }

    private static function page_payload(WP_Post $post) {
        return [
            'id' => (int) $post->ID,
            'title' => get_the_title($post),
            'slug' => $post->post_name,
            'status' => $post->post_status,
            'content' => $post->post_content,
            'has_blocks' => has_blocks($post->post_content),
            'excerpt' => $post->post_excerpt,
            'url' => get_permalink($post),
            'modified_gmt' => $post->post_modified_gmt,
        ];
    }

    private static function media_payload(WP_Post $post) {
        $metadata = wp_get_attachment_metadata($post->ID);
        return [
            'id' => (int) $post->ID,
            'title' => get_the_title($post),
            'url' => wp_get_attachment_url($post->ID),
            'mime_type' => $post->post_mime_type,
            'alt' => (string) get_post_meta($post->ID, '_wp_attachment_image_alt', true),
            'width' => isset($metadata['width']) ? (int) $metadata['width'] : null,
            'height' => isset($metadata['height']) ? (int) $metadata['height'] : null,
            'filesize' => isset($metadata['filesize']) ? (int) $metadata['filesize'] : null,
            'modified_gmt' => $post->post_modified_gmt,
        ];
    }

    public static function list_pages(WP_REST_Request $request) {
        $per_page = min(max((int) $request->get_param('per_page'), 1), 100);
        if (!$per_page) $per_page = 20;

        $query = new WP_Query([
            'post_type' => 'page',
            'post_status' => ['publish', 'draft', 'pending', 'private'],
            'posts_per_page' => $per_page,
            's' => sanitize_text_field((string) $request->get_param('search')),
            'orderby' => 'modified',
            'order' => 'DESC',
        ]);

        return rest_ensure_response(array_map([__CLASS__, 'page_payload'], $query->posts));
    }

    public static function get_page(WP_REST_Request $request) {
        $post = get_post((int) $request['id']);
        if (!$post || $post->post_type !== 'page') {
            return new WP_Error('not_found', 'Page not found.', ['status' => 404]);
        }
        return rest_ensure_response(self::page_payload($post));
    }

    public static function get_page_blocks(WP_REST_Request $request) {
        $post = get_post((int) $request['id']);
        if (!$post || $post->post_type !== 'page') {
            return new WP_Error('not_found', 'Page not found.', ['status' => 404]);
        }

        return rest_ensure_response([
            'page_id' => (int) $post->ID,
            'blocks' => parse_blocks($post->post_content),
        ]);
    }

    private static function sanitize_status($status) {
        $allowed = ['draft', 'publish', 'pending', 'private'];
        return in_array($status, $allowed, true) ? $status : 'draft';
    }

    public static function create_page(WP_REST_Request $request) {
        $data = (array) $request->get_json_params();
        $title = sanitize_text_field($data['title'] ?? 'Untitled');
        $content = isset($data['content']) ? (string) $data['content'] : '';
        $status = self::sanitize_status($data['status'] ?? 'draft');

        $post_id = wp_insert_post([
            'post_type' => 'page',
            'post_title' => $title,
            'post_content' => $content,
            'post_status' => $status,
            'post_name' => isset($data['slug']) ? sanitize_title($data['slug']) : '',
        ], true);

        if (is_wp_error($post_id)) return $post_id;
        return new WP_REST_Response(self::page_payload(get_post($post_id)), 201);
    }

    public static function update_page(WP_REST_Request $request) {
        $post = get_post((int) $request['id']);
        if (!$post || $post->post_type !== 'page') {
            return new WP_Error('not_found', 'Page not found.', ['status' => 404]);
        }

        $data = (array) $request->get_json_params();
        $update = ['ID' => $post->ID];
        if (array_key_exists('title', $data)) $update['post_title'] = sanitize_text_field($data['title']);
        if (array_key_exists('content', $data)) $update['post_content'] = (string) $data['content'];
        if (array_key_exists('status', $data)) $update['post_status'] = self::sanitize_status($data['status']);
        if (array_key_exists('slug', $data)) $update['post_name'] = sanitize_title($data['slug']);

        $result = wp_update_post($update, true);
        if (is_wp_error($result)) return $result;
        return rest_ensure_response(self::page_payload(get_post($post->ID)));
    }

    public static function list_media(WP_REST_Request $request) {
        $per_page = min(max((int) $request->get_param('per_page'), 1), 100);
        if (!$per_page) $per_page = 30;

        $query = new WP_Query([
            'post_type' => 'attachment',
            'post_status' => 'inherit',
            'post_mime_type' => 'image',
            'posts_per_page' => $per_page,
            's' => sanitize_text_field((string) $request->get_param('search')),
            'orderby' => 'modified',
            'order' => 'DESC',
        ]);

        return rest_ensure_response(array_map([__CLASS__, 'media_payload'], $query->posts));
    }

    private static function validate_remote_media_url($url) {
        if (!$url || !wp_http_validate_url($url)) {
            return new WP_Error('invalid_media_url', 'A valid public media URL is required.', ['status' => 400]);
        }

        $parts = wp_parse_url($url);
        if (($parts['scheme'] ?? '') !== 'https') {
            return new WP_Error('invalid_media_url', 'Media import requires HTTPS.', ['status' => 400]);
        }

        $host = strtolower((string) ($parts['host'] ?? ''));
        if (!$host || $host === 'localhost' || substr($host, -6) === '.local') {
            return new WP_Error('invalid_media_url', 'Local media URLs are not allowed.', ['status' => 400]);
        }

        if (filter_var($host, FILTER_VALIDATE_IP)) {
            $public = filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
            if (!$public) {
                return new WP_Error('invalid_media_url', 'Private or reserved IP addresses are not allowed.', ['status' => 400]);
            }
        }

        return true;
    }

    public static function import_media(WP_REST_Request $request) {
        $data = (array) $request->get_json_params();
        $url = esc_url_raw((string) ($data['url'] ?? ''));
        $valid = self::validate_remote_media_url($url);
        if (is_wp_error($valid)) return $valid;

        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';

        $tmp = download_url($url, 30);
        if (is_wp_error($tmp)) return $tmp;

        $path = (string) wp_parse_url($url, PHP_URL_PATH);
        $default_name = $path ? basename($path) : 'imported-asset';
        $filename = sanitize_file_name((string) ($data['filename'] ?? $default_name));
        if (!$filename) $filename = 'imported-asset';

        $file_array = [
            'name' => $filename,
            'tmp_name' => $tmp,
        ];

        $attachment_id = media_handle_sideload(
            $file_array,
            0,
            sanitize_text_field((string) ($data['title'] ?? ''))
        );

        if (is_wp_error($attachment_id)) {
            @unlink($tmp);
            return $attachment_id;
        }

        if (isset($data['alt'])) {
            update_post_meta($attachment_id, '_wp_attachment_image_alt', sanitize_text_field((string) $data['alt']));
        }

        $attachment = get_post($attachment_id);
        return new WP_REST_Response(self::media_payload($attachment), 201);
    }

    public static function get_agent_css() {
        return rest_ensure_response([
            'css' => (string) get_option(self::OPTION_CSS, ''),
            'max_bytes' => self::MAX_CSS_BYTES,
        ]);
    }

    public static function update_agent_css(WP_REST_Request $request) {
        $data = (array) $request->get_json_params();
        $css = isset($data['css']) ? (string) $data['css'] : '';
        if (strlen($css) > self::MAX_CSS_BYTES) {
            return new WP_Error('css_too_large', 'Agent CSS exceeds the maximum allowed size.', ['status' => 413]);
        }

        update_option(self::OPTION_CSS, $css, false);
        return rest_ensure_response([
            'updated' => true,
            'bytes' => strlen($css),
            'css' => $css,
        ]);
    }

    public static function render_agent_css() {
        $css = (string) get_option(self::OPTION_CSS, '');
        if (!$css) return;

        $safe_css = str_ireplace('</style', '<\\/style', $css);
        echo "\n<style id=\"chatgpt-web-agent-css\">\n" . $safe_css . "\n</style>\n";
    }

    public static function admin_menu() {
        add_options_page(
            'ChatGPT Web Agent',
            'ChatGPT Web Agent',
            'manage_options',
            'chatgpt-web-agent',
            [__CLASS__, 'settings_page']
        );
    }

    public static function settings_page() {
        if (!current_user_can('manage_options')) return;
        $token = esc_html((string) get_option(self::OPTION_TOKEN, ''));
        $css_bytes = strlen((string) get_option(self::OPTION_CSS, ''));
        $action = esc_url(admin_url('admin-post.php'));
        $nonce = wp_nonce_field('chatgpt_web_agent_regenerate', '_wpnonce', true, false);
        echo '<div class="wrap"><h1>ChatGPT Web Agent</h1>';
        echo '<p>Version <strong>0.2.0</strong>. Use this token only in the control server <code>WORDPRESS_TOKEN</code> environment variable.</p>';
        echo '<input type="text" readonly style="width:100%;max-width:760px;font-family:monospace" value="' . $token . '">';
        echo '<p>Agent-owned CSS: <strong>' . esc_html((string) $css_bytes) . ' bytes</strong>. It is injected separately and can be replaced or cleared without editing the active theme.</p>';
        echo '<form method="post" action="' . $action . '" style="margin-top:16px">' . $nonce;
        echo '<input type="hidden" name="action" value="chatgpt_web_agent_regenerate_token">';
        submit_button('Regenerate token', 'secondary', 'submit', false);
        echo '</form></div>';
    }

    public static function regenerate_token() {
        if (!current_user_can('manage_options')) wp_die('Forbidden');
        check_admin_referer('chatgpt_web_agent_regenerate');
        update_option(self::OPTION_TOKEN, wp_generate_password(48, false, false), false);
        wp_safe_redirect(admin_url('options-general.php?page=chatgpt-web-agent'));
        exit;
    }
}

ChatGPT_Web_Agent::init();
