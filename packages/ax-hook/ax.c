// Reads the accessibility tree from inside a phone process and serves it on a Unix socket.
//
// x86Sim adds this library to DYLD_INSERT_LIBRARIES of every phone process (X86SIM_INSERT). A process that has UIKit
// loaded starts a listener at /Volumes/SystemRoot/run/user/<uid>/x86sim-ax-<SIMULATOR_UDID>-<pid>.sock. Linux sees
// that file as /run/user/<uid>/x86sim-ax-<udid>-<pid>.sock. A client sends "tree\n" and gets one line of JSON back,
// then the hook closes the connection:
//
//   { "pid": 123, "bundleId": "com.apple.Preferences", "root": AxNode }
//
// SpringBoard's answer also says which app is in front, since a suspended app cannot answer and only SpringBoard knows:
//
//   { "pid": 80, "bundleId": "com.apple.springboard", "front": { "pid": 123, "bundleId": "..." } | null, "root": AxNode }
//
// "tree debug\n" adds each element's class and accessibility traits, which a reader of the shape ignores.
// AxNode is the shape of packages/server/src/types.ts. The tree is the snapshot UIKit builds for XCTest, taken on the
// main queue, so element types and containers are the ones XCTest reports. UIKit builds it only while accessibility
// automation is on. The library links nothing but libobjc and libSystem, so a daemon that never loads UIKit pays
// nothing for it. UIKit is reached through the Objective-C runtime.
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

typedef struct { double x, y, w, h; } Rect;

void *objc_autoreleasePoolPush(void);
void objc_autoreleasePoolPop(void *pool);

#define SEL_(s) sel_registerName(s)
#define SEND(ret, obj, name) ((ret (*)(id, SEL))objc_msgSend)((obj), SEL_(name))
#define SEND1(ret, argType, obj, name, arg) ((ret (*)(id, SEL, argType))objc_msgSend)((obj), SEL_(name), (arg))

static const char kSystemRoot[] = "/Volumes/SystemRoot";
static const int kMaxDepth = 60;
static const int kMaxNodes = 4000;

// ---- Objective-C helpers -------------------------------------------------------------------------------------

static bool responds(id o, const char *sel) { return o && SEND1(bool, SEL, o, "respondsToSelector:", SEL_(sel)); }
static id get(id o, const char *sel) { return responds(o, sel) ? SEND(id, o, sel) : nil; }
static bool getb(id o, const char *sel) { return responds(o, sel) && SEND(bool, o, sel); }
static long getl(id o, const char *sel) { return responds(o, sel) ? SEND(long, o, sel) : 0; }
static Rect getrect(id o, const char *sel) { return responds(o, sel) ? SEND(Rect, o, sel) : (Rect){ 0 }; }
static unsigned long count(id a) { return a ? SEND(unsigned long, a, "count") : 0; }
static id at(id a, unsigned long i) { return SEND1(id, unsigned long, a, "objectAtIndex:", i); }

static const char *utf8(id s) {
	if (!s) return NULL;
	if (!responds(s, "UTF8String")) {
		// an attributed string answers with its plain text
		id plain = get(s, "string");
		return plain && responds(plain, "UTF8String") ? SEND(const char *, plain, "UTF8String") : NULL;
	}
	return SEND(const char *, s, "UTF8String");
}

static bool kind(id o, const char *cls) {
	Class c = objc_getClass(cls);
	return o && c && SEND1(bool, Class, o, "isKindOfClass:", c);
}

// ---- a growing JSON buffer (main queue only) ---------------------------------------------------------------

static char *buf;
static size_t len, cap;

static void put(const char *s, size_t n) {
	if (len + n + 1 > cap) {
		cap = (len + n + 1) * 2;
		buf = realloc(buf, cap);
	}
	memcpy(buf + len, s, n);
	len += n;
	buf[len] = 0;
}
static void puts_(const char *s) { put(s, strlen(s)); }
static void putf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void putf(const char *fmt, ...) {
	char t[256];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(t, sizeof t, fmt, ap);
	va_end(ap);
	if (n > 0) put(t, (size_t)n < sizeof t ? (size_t)n : sizeof t - 1);
}
static void putstr(const char *s) {
	puts_("\"");
	for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
		if (*p == '"' || *p == '\\') { char t[2] = { '\\', (char)*p }; put(t, 2); }
		else if (*p == '\n') puts_("\\n");
		else if (*p == '\r') puts_("\\r");
		else if (*p == '\t') puts_("\\t");
		else if (*p < 0x20) putf("\\u%04x", *p);
		else put((const char *)p, 1);
	}
	puts_("\"");
}

// ---- the snapshot -----------------------------------------------------------------------------------------
//
// XCTest does not walk views. It asks UIKit for a snapshot of the app, a tree of dictionaries that UIKit's
// accessibility bundle builds in the app process, and reads each element's type from it. The hook asks for the same
// snapshot, so element types and containers are UIKit's own rather than a guess from traits. The snapshot names its
// attributes by number. These are the ones an AxNode needs.
enum {
	AttrLabel = 2001, AttrFrame = 2003, AttrTraits = 2004, AttrValue = 2006, AttrClass = 5003, AttrBaseClass = 5004,
	AttrIdentifier = 5019, AttrElementType = 5058,
};
static const long kAttributes[] = { AttrLabel, AttrFrame, AttrTraits, AttrValue, AttrClass, AttrBaseClass, AttrIdentifier, AttrElementType };

enum { TraitNotEnabled = 1ul << 8 };
enum { kAXValueCGRectType = 3 };

// XCUIElementType by number, as XCUIAutomation's XCUIElementTypes.h numbers them.
static const char *const kElementTypes[] = {
	"Any", "Other", "Application", "Group", "Window", "Sheet", "Drawer", "Alert", "Dialog", "Button", "RadioButton",
	"RadioGroup", "CheckBox", "DisclosureTriangle", "PopUpButton", "ComboBox", "MenuButton", "ToolbarButton", "Popover",
	"Keyboard", "Key", "NavigationBar", "TabBar", "TabGroup", "Toolbar", "StatusBar", "Table", "TableRow", "TableColumn",
	"Outline", "OutlineRow", "Browser", "CollectionView", "Slider", "PageIndicator", "ProgressIndicator",
	"ActivityIndicator", "SegmentedControl", "Picker", "PickerWheel", "Switch", "Toggle", "Link", "Image", "Icon",
	"SearchField", "ScrollView", "ScrollBar", "StaticText", "TextField", "SecureTextField", "DatePicker", "TextView",
	"Menu", "MenuItem", "MenuBar", "MenuBarItem", "Map", "WebView", "IncrementArrow", "DecrementArrow", "Timeline",
	"RatingIndicator", "ValueIndicator", "SplitGroup", "Splitter", "RelevanceIndicator", "ColorWell", "HelpTag", "Matte",
	"DockItem", "Ruler", "RulerMarker", "Grid", "LevelIndicator", "Cell", "LayoutArea", "LayoutItem", "Handle", "Stepper",
	"Tab", "TouchBar", "StatusItem",
};

static Rect g_screen;
static int g_nodes;
static bool g_debug;
static id g_keyAttributes, g_keyChildren;
static bool (*g_axValueGetValue)(id value, int type, void *out);

static id nsstring(const char *s) { return SEND1(id, const char *, (id)objc_getClass("NSString"), "stringWithUTF8String:", s); }
static id nsnumber(long n) { return SEND1(id, long, (id)objc_getClass("NSNumber"), "numberWithLong:", n); }
static id lookup(id dict, id key) { return dict && kind(dict, "NSDictionary") ? SEND1(id, id, dict, "objectForKey:", key) : nil; }
static id attr(id attrs, long a) { return lookup(attrs, nsnumber(a)); }
static const char *attr_str(id attrs, long a) {
	id v = attr(attrs, a);
	return v && !kind(v, "NSNull") ? utf8(v) : NULL;
}

/// What XCTest reports for an element. UIKit reports a window as an application and leaves plain views as Any, which
/// XCTest shows as Window and Other.
static const char *type_name(id attrs) {
	const char *base = attr_str(attrs, AttrBaseClass);
	if (base && strcmp(base, "UIWindow") == 0) return "Window";
	long n = getl(attr(attrs, AttrElementType), "longValue");
	if (n <= 0 || n >= (long)(sizeof kElementTypes / sizeof *kElementTypes)) return "Other";
	return kElementTypes[n];
}

static Rect frame_of(id attrs) {
	Rect r = { 0 };
	id v = attr(attrs, AttrFrame);
	if (v && g_axValueGetValue && !g_axValueGetValue(v, kAXValueCGRectType, &r)) r = (Rect){ 0 };
	return r;
}

static bool intersects_screen(Rect f) {
	return f.w > 0 && f.h > 0 && f.x < g_screen.x + g_screen.w && f.x + f.w > g_screen.x && f.y < g_screen.y + g_screen.h &&
	       f.y + f.h > g_screen.y;
}

/// One snapshot dictionary as an AxNode, with its children. The root is the application.
static void emit_node(id snap, int depth) {
	g_nodes++;
	id attrs = lookup(snap, g_keyAttributes);
	unsigned long traits = (unsigned long)getl(attr(attrs, AttrTraits), "unsignedLongLongValue");
	const char *label = attr_str(attrs, AttrLabel);
	const char *value = attr_str(attrs, AttrValue);
	const char *ident = attr_str(attrs, AttrIdentifier);
	Rect f = depth == 0 ? g_screen : frame_of(attrs);
	putf("{\"type\":\"XCUIElementType%s\"", depth == 0 ? "Application" : type_name(attrs));
	if (ident && *ident) { puts_(",\"name\":"); putstr(ident); }
	if (label && *label) { puts_(",\"label\":"); putstr(label); }
	if (value && *value) { puts_(",\"value\":"); putstr(value); }
	putf(",\"frame\":{\"x\":%.2f,\"y\":%.2f,\"width\":%.2f,\"height\":%.2f},\"enabled\":%s,\"visible\":%s", f.x, f.y, f.w, f.h,
	     traits & TraitNotEnabled ? "false" : "true", depth == 0 || intersects_screen(f) ? "true" : "false");
	if (g_debug) {
		puts_(",\"class\":");
		putstr(attr_str(attrs, AttrClass));
		putf(",\"traits\":%lu", traits);
	}
	puts_(",\"children\":[");
	id kids = lookup(snap, g_keyChildren);
	for (unsigned long i = 0, n = kids && kind(kids, "NSArray") ? count(kids) : 0; i < n && g_nodes < kMaxNodes; i++) {
		if (i) puts_(",");
		emit_node(at(kids, i), depth + 1);
	}
	puts_("]}");
}

/// UIKit's snapshot of the app, or nil when its accessibility bundle is not loaded because accessibility is off.
static id app_snapshot(id app) {
	const char *sel = "_accessibilityUserTestingSnapshotDescendantsWithAttributes:maxDepth:maxChildren:maxArrayCount:honorsModalViews:";
	if (!responds(app, sel)) return nil;
	id attrs = SEND(id, (id)objc_getClass("NSMutableArray"), "array");
	for (size_t i = 0; i < sizeof kAttributes / sizeof *kAttributes; i++) SEND1(void, id, attrs, "addObject:", nsnumber(kAttributes[i]));
	return ((id(*)(id, SEL, id, unsigned long, unsigned long, unsigned long, bool))objc_msgSend)(app, SEL_(sel), attrs, kMaxDepth,
	                                                                                           kMaxNodes, kMaxNodes, true);
}

static id shared_application(void) {
	Class c = objc_getClass("UIApplication");
	return c && responds((id)c, "sharedApplication") ? SEND(id, (id)c, "sharedApplication") : nil;
}

static bool is_springboard(void) { return strcmp(getprogname(), "SpringBoard") == 0; }

static const char *bundle_id(void) {
	Class c = objc_getClass("NSBundle");
	id main = c ? get((id)c, "mainBundle") : nil;
	const char *id_ = utf8(get(main, "bundleIdentifier"));
	return id_ ? id_ : is_springboard() ? "com.apple.springboard" : getprogname();
}

/// Foreground system services that SpringBoard lists among its applications: the keyboard and the home screen's
/// widgets. Neither is the app in front.
static const char *const kSystemServices[] = { "InputUI", "WidgetRenderer" };

/// Is `app`, an SBApplication, an app running in the foreground? On success `bundle` and `pid` say which.
static bool foreground_app(id app, const char **bundle, long *pid) {
	id state = get(app, "processState");
	const char *b = utf8(get(app, "bundleIdentifier"));
	if (!state || !getb(state, "isForeground") || !b) return false;
	for (size_t i = 0; i < sizeof kSystemServices / sizeof *kSystemServices; i++)
		if (strstr(b, kSystemServices[i])) return false;
	*bundle = b;
	*pid = getl(state, "pid");
	return true;
}

/// SpringBoard only: the app in front, or null on the home screen. SpringBoard names it directly when it can, and
/// otherwise the running application that is in the foreground is the one.
static void put_front(id springboard) {
	const char *bundle = NULL;
	long pid = 0;
	bool found = foreground_app(get(springboard, "_accessibilityFrontMostApplication"), &bundle, &pid);
	Class controllerClass = objc_getClass("SBApplicationController");
	id running = controllerClass ? get(get((id)controllerClass, "sharedInstanceIfExists"), "runningApplications") : nil;
	for (unsigned long i = 0, n = count(running); !found && i < n; i++) found = foreground_app(at(running, i), &bundle, &pid);
	if (!found) {
		puts_(",\"front\":null");
	} else {
		putf(",\"front\":{\"pid\":%ld,\"bundleId\":", pid);
		putstr(bundle);
		puts_("}");
	}
	if (!g_debug) return;
	puts_(",\"runningApplications\":[");
	for (unsigned long i = 0, n = count(running); i < n; i++) {
		id app = at(running, i), state = get(app, "processState");
		putf("%s{\"bundleId\":", i ? "," : "");
		putstr(utf8(get(app, "bundleIdentifier")));
		putf(",\"pid\":%ld,\"foreground\":%s,\"state\":\"%s\"}", getl(state, "pid"), getb(state, "isForeground") ? "true" : "false",
		     state ? object_getClassName(state) : "none");
	}
	puts_("]");
	id named = get(springboard, "_accessibilityFrontMostApplication");
	putf(",\"frontMostApplication\":\"%s\"", named ? object_getClassName(named) : "nil");
}

static void build_tree(void) {
	len = 0;
	g_nodes = 0;
	if (!g_keyAttributes) {
		g_keyAttributes = SEND(id, nsstring("UIAccessibilitySnapshotKeyAttributes"), "retain");
		g_keyChildren = SEND(id, nsstring("UIAccessibilitySnapshotKeyChildren"), "retain");
		g_axValueGetValue = (bool (*)(id, int, void *))dlsym(RTLD_DEFAULT, "AXValueGetValue");
	}
	id app = shared_application();
	Class screenClass = objc_getClass("UIScreen");
	id screen = screenClass ? get((id)screenClass, "mainScreen") : nil;
	g_screen = getrect(screen, "bounds");
	id snap = app_snapshot(app);
	if (!snap) {
		puts_("{\"error\":\"UIKit's accessibility is off in this process. Turn it on in com.apple.Accessibility.\"}\n");
		return;
	}
	putf("{\"pid\":%d,\"bundleId\":", getpid());
	putstr(bundle_id());
	if (is_springboard()) put_front(app);
	puts_(",\"root\":");
	emit_node(snap, 0);
	puts_("}\n");
}

// ---- the socket -------------------------------------------------------------------------------------------

static void write_all(int fd, const char *data, size_t n) {
	while (n > 0) {
		ssize_t w = write(fd, data, n);
		if (w <= 0) return;
		data += w;
		n -= (size_t)w;
	}
}

/// Runs on the main queue. It answers and closes the connection itself, so a stalled main queue costs a waiting client
/// and nothing else.
static void answer(void *ctx) {
	int fd = (int)(intptr_t)ctx & 0xffffff, debug = (int)((intptr_t)ctx >> 24);
	g_debug = debug != 0;
	void *pool = objc_autoreleasePoolPush();
	build_tree();
	objc_autoreleasePoolPop(pool);
	write_all(fd, buf, len);
	close(fd);
}

static void *serve_client(void *arg) {
	int fd = (int)(intptr_t)arg;
	char line[64];
	size_t n = 0;
	while (n < sizeof line - 1) {
		ssize_t r = read(fd, line + n, 1);
		if (r <= 0 || line[n] == '\n') break;
		n++;
	}
	line[n] = 0;
	if (strcmp(line, "tree") == 0 || strcmp(line, "tree debug") == 0) {
		intptr_t ctx = fd | (strcmp(line, "tree debug") == 0 ? (intptr_t)1 << 24 : 0);  // descriptors are small
		dispatch_async_f(dispatch_get_main_queue(), (void *)ctx, answer);
	} else {
		write_all(fd, "{\"error\":\"unknown request\"}\n", 28);
		close(fd);
	}
	return NULL;
}

/// Where the socket lives. A path longer than sockaddr_un's 104 bytes cannot be bound, so it sits in the short
/// directory x86Sim keeps its frame ring in (/run/user/<uid>), which is the same place on Linux.
static bool socket_path(char *out, size_t size) {
	const char *udid = getenv("SIMULATOR_UDID");
	const char *ring = getenv("SIMFB_RING");
	const char *slash = ring ? strrchr(ring, '/') : NULL;
	char dir[256];
	if (slash && strncmp(ring, kSystemRoot, sizeof kSystemRoot - 1) == 0) snprintf(dir, sizeof dir, "%.*s", (int)(slash - ring), ring);
	else snprintf(dir, sizeof dir, "%s/run/user/%u", kSystemRoot, (unsigned)getuid());
	int w = snprintf(out, size, "%s/x86sim-ax-%s-%d.sock", dir, udid && *udid ? udid : "unknown", getpid());
	return w > 0 && (size_t)w < size;
}

static void *listen_thread(void *arg) {
	struct sockaddr_un addr = { 0 };
	char path[sizeof addr.sun_path];
	if (!socket_path(path, sizeof path)) return NULL;
	int s = socket(AF_UNIX, SOCK_STREAM, 0);
	if (s < 0) return NULL;
	addr.sun_family = AF_UNIX;
	strlcpy(addr.sun_path, path, sizeof addr.sun_path);
	unlink(path);
	if (bind(s, (struct sockaddr *)&addr, sizeof addr) != 0 || listen(s, 8) != 0) {
		close(s);
		return NULL;
	}
	for (;;) {
		// Darling's accept() crashes with a NULL address, so pass a real one.
		struct sockaddr_un peer;
		socklen_t peerLen = sizeof peer;
		int c = accept(s, (struct sockaddr *)&peer, &peerLen);
		if (c < 0) {
			usleep(100000);
			continue;
		}
		int one = 1;
		setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
		pthread_t t;
		if (pthread_create(&t, NULL, serve_client, (void *)(intptr_t)c) == 0) pthread_detach(t);
		else close(c);
	}
	return NULL;
}

// ---- start-up ---------------------------------------------------------------------------------------------

static void image_added(const struct mach_header *mh, intptr_t slide) {
	static bool started;
	if (started || !objc_getClass("UIApplication")) return;
	started = true;
	pthread_t t;
	if (pthread_create(&t, NULL, listen_thread, NULL) == 0) pthread_detach(t);
}

__attribute__((constructor)) static void init(void) { _dyld_register_func_for_add_image(image_added); }
