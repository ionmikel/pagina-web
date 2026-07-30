const kQueryArg = "q";
const kResultsArg = "show-results";

// If items don't provide a URL, then both the navigator and the onSelect
// function aren't called (and therefore, the default implementation is used)
//
// We're using this sentinel URL to signal to those handlers that this
// item is a more item (along with the type) and can be handled appropriately
const kItemTypeMoreHref = "0767FDFD-0422-4E5A-BC8A-3BE11E5BBA05";

// Capture search params and clean ?q= from URL at module load time, before
// any DOMContentLoaded handlers run. quarto-nav.js resolves all <a> hrefs
// against window.location during DOMContentLoaded â€” if ?q= is still present,
// every link on the page gets the query param baked into its href.
const currentUrl = new URL(window.location);
const kQuery = currentUrl.searchParams.get(kQueryArg);
if (kQuery) {
  const replacementUrl = new URL(window.location);
  replacementUrl.searchParams.delete(kQueryArg);
  window.history.replaceState({}, "", replacementUrl);
}

window.document.addEventListener("DOMContentLoaded", function (_event) {
  // Ensure that search is available on this page. If it isn't,
  // should return early and not do anything
  var searchEl = window.document.getElementById("quarto-search");
  if (!searchEl) return;

  const { autocomplete } = window["@algolia/autocomplete-js"];

  let quartoSearchOptions = {};
  let language = {};
  const searchOptionEl = window.document.getElementById(
    "quarto-search-options"
  );
  if (searchOptionEl) {
    const jsonStr = searchOptionEl.textContent;
    quartoSearchOptions = JSON.parse(jsonStr);
    language = quartoSearchOptions.language;
  }

  // note the search mode
  if (quartoSearchOptions.type === "overlay") {
    searchEl.classList.add("type-overlay");
  } else {
    searchEl.classList.add("type-textbox");
  }

  // Used to determine highlighting behavior for this page
  // A `q` query param is expected when the user follows a search
  // to this page
  const query = kQuery;
  const showSearchResults = currentUrl.searchParams.get(kResultsArg);
  const mainEl = window.document.querySelector("main");

  // highlight matches on the page
  if (query && mainEl) {
    highlight(query, mainEl);

    // Activate tabs on pageshow â€” after tabsets.js restores localStorage state.
    // tabsets.js registers its pageshow handler during module execution (before
    // DOMContentLoaded). By registering ours during DOMContentLoaded, listener
    // ordering guarantees we run after tabsets.js â€” so search activation wins.
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted) {
        for (const mark of mainEl.querySelectorAll("mark")) {
          openAllTabsetsContainingEl(mark);
        }
        // Only scroll to first match when there's no hash fragment.
        // With a hash, the browser already scrolled to the target section.
        if (!currentUrl.hash) {
          requestAnimationFrame(() => scrollToFirstVisibleMatch(mainEl));
        }
      }
    }, { once: true });
  }

  // function to clear highlighting on the page when the search query changes
  // (e.g. if the user edits the query or clears it)
  let highlighting = true;
  const resetHighlighting = (searchTerm) => {
    if (mainEl && highlighting && query && searchTerm !== query) {
      clearHighlight(query, mainEl);
      highlighting = false;
    }
  };

  // Responsively switch to overlay mode if the search is present on the navbar
  // Note that switching the sidebar to overlay mode requires more coordinate (not just
  // the media query since we generate different HTML for sidebar overlays than we do
  // for sidebar input UI)
  const detachedMediaQuery =
    quartoSearchOptions.type === "overlay" ? "all" : "(max-width: 991px)";

  // If configured, include the analytics client to send insights
  const plugins = configurePlugins(quartoSearchOptions);

  let lastState = null;
  const { setIsOpen, setQuery, setCollections } = autocomplete({
    container: searchEl,
    detachedMediaQuery: detachedMediaQuery,
    defaultActiveItemId: 0,
    panelContainer: "#quarto-search-results",
    panelPlacement: quartoSearchOptions["panel-placement"],
    debug: false,
    openOnFocus: true,
    plugins,
    classNames: {
      form: "d-flex",
    },
    placeholder: language["search-text-placeholder"],
    translations: {
      clearButtonTitle: language["search-clear-button-title"],
      detachedCancelButtonText: language["search-detached-cancel-button-title"],
      submitButtonTitle: language["search-submit-button-title"],
    },
    initialState: {
      query,
    },
    getItemUrl({ item }) {
      return item.href;
    },
    onStateChange({ state }) {
      // If this is a file URL, note that

      // Perhaps reset highlighting
      resetHighlighting(state.query);

      // If the panel just opened, ensure the panel is positioned properly
      if (state.isOpen) {
        if (lastState && !lastState.isOpen) {
          setTimeout(() => {
            positionPanel(quartoSearchOptions["panel-placement"]);
          }, 150);
        }
      }

      // Perhaps show the copy link
      showCopyLink(state.query, quartoSearchOptions);

      lastState = state;
    },
    reshape({ sources, state }) {
      return sources.map((source) => {
        try {
          const items = source.getItems();

          // Validate the items
          validateItems(items);

          // group the items by document
          const groupedItems = new Map();
          items.forEach((item) => {
            const hrefParts = item.href.split("#");
            const baseHref = hrefParts[0];
            const isDocumentItem = hrefParts.length === 1;

            const items = groupedItems.get(baseHref);
            if (!items) {
              groupedItems.set(baseHref, [item]);
            } else {
              // If the href for this item matches the document
              // exactly, place this item first as it is the item that represents
              // the document itself
              if (isDocumentItem) {
                items.unshift(item);
              } else {
                items.push(item);
              }
              groupedItems.set(baseHref, items);
            }
          });

          const reshapedItems = [];
          let count = 1;
          for (const [_key, value] of groupedItems) {
            const firstItem = value[0];
            reshapedItems.push({
              ...firstItem,
              type: kItemTypeDoc,
            });

            const collapseMatches = quartoSearchOptions["collapse-after"];
            const collapseCount =
              typeof collapseMatches === "number" ? collapseMatches : 1;

            if (value.length > 1) {
              const target = `search-more-${count}`;
              const isExpanded =
                state.context.expanded &&
                state.context.expanded.includes(target);

              const remainingCount = value.length - collapseCount;

              for (let i = 1; i < value.length; i++) {
                if (collapseMatches && i === collapseCount) {
                  reshapedItems.push({
                    target,
                    title: isExpanded
                      ? language["search-hide-matches-text"]
                      : remainingCount === 1
                        ? `${remainingCount} ${language["search-more-match-text"]}`
                        : `${remainingCount} ${language["search-more-matches-text"]}`,
                    type: kItemTypeMore,
                    href: kItemTypeMoreHref,
                  });
                }

                if (isExpanded || !collapseMatches || i < collapseCount) {
                  reshapedItems.push({
                    ...value[i],
                    type: kItemTypeItem,
                    target,
                  });
                }
              }
            }
            count += 1;
          }

          return {
            ...source,
            getItems() {
              return reshapedItems;
            },
          };
        } catch (error) {
          // Some form of error occurred
          return {
            ...source,
            getItems() {
              return [
                {
                  title: error.name || "An Error Occurred While Searching",
                  text:
                    error.message ||
                    "An unknown error occurred while attempting to perform the requested search.",
                  type: kItemTypeError,
                },
              ];
            },
          };
        }
      });
    },
    navigator: {
      navigate({ itemUrl }) {
        if (itemUrl !== offsetURL(kItemTypeMoreHref)) {
          window.location.assign(itemUrl);
        }
      },
      navigateNewTab({ itemUrl }) {
        if (itemUrl !== offsetURL(kItemTypeMoreHref)) {
          const windowReference = window.open(itemUrl, "_blank", "noopener");
          if (windowReference) {
            windowReference.focus();
          }
        }
      },
      navigateNewWindow({ itemUrl }) {
        if (itemUrl !== offsetURL(kItemTypeMoreHref)) {
          window.open(itemUrl, "_blank", "noopener");
        }
      },
    },
    getSources({ state, setContext, setActiveItemId, refresh }) {
      return [
        {
          sourceId: "documents",
          getItemUrl({ item }) {
            if (item.href) {
              return offsetURL(item.href);
            } else {
              return undefined;
            }
          },
          onSelect({
            item,
            state,
            setContext,
            setIsOpen,
            setActiveItemId,
            refresh,
          }) {
            if (item.type === kItemTypeMore) {
              toggleExpanded(item, state, setContext, setActiveItemId, refresh);

              // Toggle more
              setIsOpen(true);
            }
          },
          getItems({ query }) {
            if (query === null || query === "") {
              return [];
            }

            const limit = quartoSearchOptions.limit;
            if (quartoSearchOptions.algolia) {
              return algoliaSearch(query, limit, quartoSearchOptions.algolia);
            } else {
              // Fuse search options
              const fuseSearchOptions = {
                isCaseSensitive: false,
                shouldSort: true,
                minMatchCharLength: 2,
                limit: limit,
              };

              return readSearchData().then(function (fuse) {
                return fuseSearch(query, fuse, fuseSearchOptions);
              });
            }
          },
          templates: {
            noResults({ createElement }) {
              const hasQuery = lastState.query;

              return createElement(
                "div",
                {
                  class: `quarto-search-no-results${hasQuery ? "" : " no-query"
                    }`,
                },
                language["search-no-results-text"]
              );
            },
            header({ items, createElement }) {
              // count the documents
              const count = items.filter((item) => {
                return item.type === kItemTypeDoc;
              }).length;

              if (count > 0) {
                return createElement(
                  "div",
                  { class: "search-result-header" },
                  `${count} ${language["search-matching-documents-text"]}`
                );
              } else {
                return createElement(
                  "div",
                  { class: "search-result-header-no-results" },
                  ``
                );
              }
            },
            footer({ _items, createElement }) {
              if (
                quartoSearchOptions.algolia &&
                quartoSearchOptions.algolia["show-logo"]
              ) {
                const libDir = quartoSearchOptions.algolia["libDir"];
                const logo = createElement("img", {
                  src: offsetURL(
                    `${libDir}/quarto-search/search-by-algolia.svg`
                  ),
                  class: "algolia-search-logo",
                });
                return createElement(
                  "a",
                  { href: "http://www.algolia.com/" },
                  logo
                );
              }
            },

            item({ item, createElement }) {
              if (item.text && item.href && !item.href.includes('?q=')) {
                const [main, hash] = item.href.split('#')
                const hashAppend = hash ? '#' + hash : ''
                item.href = main + '?q=' + encodeURIComponent(state.query) + hashAppend
              }

              return renderItem(
                item,
                createElement,
                state,
                setActiveItemId,
                setContext,
                refresh,
                quartoSearchOptions
              );
            },
          },
        },
      ];
    },
  });

  window.quartoOpenSearch = () => {
    setIsOpen(false);
    setIsOpen(true);
    focusSearchInput();
  };

  document.addEventListener("keyup", (event) => {
    const { key } = event;
    const kbds = quartoSearchOptions["keyboard-shortcut"];
    const focusedEl = document.activeElement;

    const isFormElFocused = [
      "input",
      "select",
      "textarea",
      "button",
      "option",
    ].find((tag) => {
      return focusedEl.tagName.toLowerCase() === tag;
    });

    if (
      kbds &&
      kbds.includes(key) &&
      !isFormElFocused &&
      !document.activeElement.isContentEditable
    ) {
      event.preventDefault();
      window.quartoOpenSearch();
    }
  });

  // Remove the labeleledby attribute since it is pointing
  // to a non-existent label
  if (quartoSearchOptions.type === "overlay") {
    const inputEl = window.document.querySelector(
      "#quarto-search .aa-Autocomplete"
    );
    if (inputEl) {
      inputEl.removeAttribute("aria-labelledby");
    }
  }

  function throttle(func, wait) {
    let waiting = false;
    return function () {
      if (!waiting) {
        func.apply(this, arguments);
        waiting = true;
        setTimeout(function () {
          waiting = false;
        }, wait);
      }
    };
  }

  // If the main document scrolls dismiss the search results
  // (otherwise, since they're floating in the document they can scroll with the document)
  window.document.body.onscroll = throttle(() => {
    // Only do this if we're not detached
    // Bug #7117
    // This will happen when the keyboard is shown on ios (resulting in a scroll)
    // which then closed the search UI
    if (!window.matchMedia(detachedMediaQuery).matches) {
      setIsOpen(false);
    }
  }, 50);

  if (showSearchResults) {
    setIsOpen(true);
    focusSearchInput();
  }
});

function configurePlugins(quartoSearchOptions) {
  const autocompletePlugins = [];
  const algoliaOptions = quartoSearchOptions.algolia;
  if (
    algoliaOptions &&
    algoliaOptions["analytics-events"] &&
    algoliaOptions["search-only-api-key"] &&
    algoliaOptions["application-id"]
  ) {
    const apiKey = algoliaOptions["search-only-api-key"];
    const appId = algoliaOptions["application-id"];

    // Aloglia insights may not be loaded because they require cookie consent
    // Use deferred loading so events will start being recorded when/if consent
    // is granted.
    const algoliaInsightsDeferredPlugin = deferredLoadPlugin(() => {
      if (
        window.aa &&
        window["@algolia/autocomplete-plugin-algolia-insights"]
      ) {
        // Check if cookie consent is enabled from search options
        const cookieConsentEnabled = algoliaOptions["cookie-consent-enabled"] || false;

        // Generate random session token only when cookies are disabled
        const userToken = cookieConsentEnabled ? undefined : Array.from(Array(20), () =>
          Math.floor(Math.random() * 36).toString(36)
        ).join("");

        window.aa("init", {
          appId,
          apiKey,
          useCookie: cookieConsentEnabled,
          userToken: userToken,
        });

        const { createAlgoliaInsightsPlugin } =
          window["@algolia/autocomplete-plugin-algolia-insights"];
        // Register the insights client
        const algoliaInsightsPlugin = createAlgoliaInsightsPlugin({
          insightsClient: window.aa,
          onItemsChange({ insights, insightsEvents }) {
            const events = insightsEvents.flatMap((event) => {
              // This API limits the number of items per event to 20
              const chunkSize = 20;
              const itemChunks = [];
              const eventItems = event.items;
              for (let i = 0; i < eventItems.length; i += chunkSize) {
                itemChunks.push(eventItems.slice(i, i + chunkSize));
              }
              // Split the items into multiple events that can be sent
              const events = itemChunks.map((items) => {
                return {
                  ...event,
                  items,
                };
              });
              return events;
            });

            for (const event of events) {
              insights.viewedObjectIDs(event);
            }
          },
        });
        return algoliaInsightsPlugin;
      }
    });

    // Add the plugin
    autocompletePlugins.push(algoliaInsightsDeferredPlugin);
    return autocompletePlugins;
  }
}

// For plugins that may not load immediately, create a wrapper
// plugin and forward events and plugin data once the plugin
// is initialized. This is useful for cases like cookie consent
// which may prevent the analytics insights event plugin from initializing
// immediately.
function deferredLoadPlugin(createPlugin) {
  let plugin = undefined;
  let subscribeObj = undefined;
  const wrappedPlugin = () => {
    if (!plugin && subscribeObj) {
      plugin = createPlugin();
      if (plugin && plugin.subscribe) {
        plugin.subscribe(subscribeObj);
      }
    }
    return plugin;
  };

  return {
    subscribe: (obj) => {
      subscribeObj = obj;
    },
    onStateChange: (obj) => {
      const plugin = wrappedPlugin();
      if (plugin && plugin.onStateChange) {
        plugin.onStateChange(obj);
      }
    },
    onSubmit: (obj) => {
      const plugin = wrappedPlugin();
      if (plugin && plugin.onSubmit) {
        plugin.onSubmit(obj);
      }
    },
    onReset: (obj) => {
      const plugin = wrappedPlugin();
      if (plugin && plugin.onReset) {
        plugin.onReset(obj);
      }
    },
    getSources: (obj) => {
      const plugin = wrappedPlugin();
      if (plugin && plugin.getSources) {
        return plugin.getSources(obj);
      } else {
        return Promise.resolve([]);
      }
    },
    data: (obj) => {
      const plugin = wrappedPlugin();
      if (plugin && plugin.data) {
        plugin.data(obj);
      }
    },
  };
}

function validateItems(items) {
  // Validate the first item
  if (items.length > 0) {
    const item = items[0];
    const missingFields = [];
    if (item.href == undefined) {
      missingFields.push("href");
    }
    if (!item.title == undefined) {
      missingFields.push("title");
    }
    if (!item.text == undefined) {
      missingFields.push("text");
    }

    if (missingFields.length === 1) {
      throw {
        name: `Error: Search index is missing the <code>${missingFields[0]}</code> field.`,
        message: `The items being returned for this search do not include all the required fields. Please ensure that your index items include the <code>${missingFields[0]}</code> field or use <code>index-fields</code> in your <code>_quarto.yml</code> file to specify the field names.`,
      };
    } else if (missingFields.length > 1) {
      const missingFieldList = missingFields
        .map((field) => {
          return `<code>${field}</code>`;
        })
        .join(", ");

      throw {
        name: `Error: Search index is missing the following fields: ${missingFieldList}.`,
        message: `The items being returned for this search do not include all the required fields. Please ensure that your index items includes the following fields: ${missingFieldList}, or use <code>index-fields</code> in your <code>_quarto.yml</code> file to specify the field names.`,
      };
    }
  }
}

let lastQuery = null;
function showCopyLink(query, options) {
  const language = options.language;
  lastQuery = query;
  // Insert share icon
  const inputSuffixEl = window.document.body.querySelector(
    ".aa-Form .aa-InputWrapperSuffix"
  );

  if (inputSuffixEl) {
    let copyButtonEl = window.document.body.querySelector(
      ".aa-Form .aa-InputWrapperSuffix .aa-CopyButton"
    );

    if (copyButtonEl === null) {
      copyButtonEl = window.document.createElement("button");
      copyButtonEl.setAttribute("class", "aa-CopyButton");
      copyButtonEl.setAttribute("type", "button");
      copyButtonEl.setAttribute("title", language["search-copy-link-title"]);
      copyButtonEl.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      const linkIcon = "bi-clipboard";
      const checkIcon = "bi-check2";

      const shareIconEl = window.document.createElement("i");
      shareIconEl.setAttribute("class", `bi ${linkIcon}`);
      copyButtonEl.appendChild(shareIconEl);
      inputSuffixEl.prepend(copyButtonEl);

      const clipboard = new window.ClipboardJS(".aa-CopyButton", {
        text: function (_trigger) {
          const copyUrl = new URL(window.location);
          copyUrl.searchParams.set(kQueryArg, lastQuery);
          copyUrl.searchParams.set(kResultsArg, "1");
          return copyUrl.toString();
        },
      });
      clipboard.on("success", function (e) {
        // Focus the input

        // button target
        const button = e.trigger;
        const icon = button.querySelector("i.bi");

        // flash "checked"
        icon.classList.add(checkIcon);
        icon.classList.remove(linkIcon);
        setTimeout(function () {
          icon.classList.remove(checkIcon);
          icon.classList.add(linkIcon);
        }, 1000);
      });
    }

    // If there is a query, show the link icon
    if (copyButtonEl) {
      if (lastQuery && options["copy-button"]) {
        copyButtonEl.style.display = "flex";
      } else {
        copyButtonEl.style.display = "none";
      }
    }
  }
}

/* Search Index Handling */
// create the index
var fuseIndex = undefined;
var shownWarning = false;

// fuse index options
const kFuseIndexOptions = {
  keys: [
    { name: "title", weight: 20 },
    { name: "section", weight: 20 },
    { name: "text", weight: 10 },
  ],
  ignoreLocation: true,
  threshold: 0.1,
};

async function readSearchData() {
  // Initialize the search index on demand
  if (fuseIndex === undefined) {
    if (window.location.protocol === "file:" && !shownWarning) {
      window.alert(
        "Search requires JavaScript features disabled when running in file://... URLs. In order to use search, please run this document in a web server."
      );
      shownWarning = true;
      return;
    }
    const fuse = new window.Fuse([], kFuseIndexOptions);

    // fetch the main search.json
    const response = await fetch(offsetURL("search.json"));
    if (response.status == 200) {
      return response.json().then(function (searchDocs) {
        searchDocs.forEach(function (searchDoc) {
          fuse.add(searchDoc);
        });
        fuseIndex = fuse;
        return fuseIndex;
      });
    } else {
      return Promise.reject(
        new Error(
          "Unexpected status from search index request: " + response.status
        )
      );
    }
  }

  return fuseIndex;
}

function inputElement() {
  return window.document.body.querySelector(".aa-Form .aa-Input");
}

function focusSearchInput() {
  setTimeout(() => {
    const inputEl = inputElement();
    if (inputEl) {
      inputEl.focus();
    }
  }, 50);
}

/* Panels */
const kItemTypeDoc = "document";
const kItemTypeMore = "document-more";
const kItemTypeItem = "document-item";
const kItemTypeError = "error";

function renderItem(
  item,
  createElement,
  state,
  setActiveItemId,
  setContext,
  refresh,
  quartoSearchOptions
) {
  switch (item.type) {
    case kItemTypeDoc:
      return createDocumentCard(
        createElement,
        "file-richtext",
        item.title,
        item.section,
        item.text,
        item.href,
        item.crumbs,
        quartoSearchOptions
      );
    case kItemTypeMore:
      return createMoreCard(
        createElement,
        item,
        state,
        setActiveItemId,
        setContext,
        refresh
      );
    case kItemTypeItem:
      return createSectionCard(
        createElement,
        item.section,
        item.text,
        item.href
      );
    case kItemTypeError:
      return createErrorCard(createElement, item.title, item.text);
    default:
      return undefined;
  }
}

function createDocumentCard(
  createElement,
  icon,
  title,
  section,
  text,
  href,
  crumbs,
  quartoSearchOptions
) {
  const iconEl = createElement("i", {
    class: `bi bi-${icon} search-result-icon`,
  });
  const titleEl = createElement("p", { class: "search-result-title" }, title);
  const titleContents = [iconEl, titleEl];
  const showParent = quartoSearchOptions["show-item-context"];
  if (crumbs && showParent) {
    let crumbsOut = undefined;
    const crumbClz = ["search-result-crumbs"];
    if (showParent === "root") {
      crumbsOut = crumbs.length > 1 ? crumbs[0] : undefined;
    } else if (showParent === "parent") {
      crumbsOut = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined;
    } else {
      crumbsOut = crumbs.length > 1 ? crumbs.join(" > ") : undefined;
      crumbClz.push("search-result-crumbs-wrap");
    }

    const crumbEl = createElement(
      "p",
      { class: crumbClz.join(" ") },
      crumbsOut
    );
    titleContents.push(crumbEl);
  }

  const titleContainerEl = createElement(
    "div",
    { class: "search-result-title-container" },
    titleContents
  );

  const textEls = [];
  if (section) {
    const sectionEl = createElement(
      "p",
      { class: "search-result-section" },
      section
    );
    textEls.push(sectionEl);
  }
  const descEl = createElement("p", {
    class: "search-result-text",
    dangerouslySetInnerHTML: {
      __html: text,
    },
  });
  textEls.push(descEl);

  const textContainerEl = createElement(
    "div",
    { class: "search-result-text-container" },
    textEls
  );

  const containerEl = createElement(
    "div",
    {
      class: "search-result-container",
    },
    [titleContainerEl, textContainerEl]
  );

  const linkEl = createElement(
    "a",
    {
      href: offsetURL(href),
      class: "search-result-link",
    },
    containerEl
  );

  const classes = ["search-result-doc", "search-item"];
  if (!section) {
    classes.push("document-selectable");
  }

  return createElement(
    "div",
    {
      class: classes.join(" "),
    },
    linkEl
  );
}

function createMoreCard(
  createElement,
  item,
  state,
  setActiveItemId,
  setContext,
  refresh
) {
  const moreCardEl = createElement(
    "div",
    {
      class: "search-result-more search-item",
      onClick: (e) => {
        // Handle expanding the sections by adding the expanded
        // section to the list of expanded sections
        toggleExpanded(item, state, setContext, setActiveItemId, refresh);
        e.stopPropagation();
      },
    },
    item.title
  );

  return moreCardEl;
}

function toggleExpanded(item, state, setContext, setActiveItemId, refresh) {
  const expanded = state.context.expanded || [];
  if (expanded.includes(item.target)) {
    setContext({
      expanded: expanded.filter((target) => target !== item.target),
    });
  } else {
    setContext({ expanded: [...expanded, item.target] });
  }

  refresh();
  setActiveItemId(item.__autocomplete_id);
}

function createSectionCard(createElement, section, text, href) {
  const sectionEl = createSection(createElement, section, text, href);
  return createElement(
    "div",
    {
      class: "search-result-doc-section search-item",
    },
    sectionEl
  );
}

function createSection(createElement, title, text, href) {
  const descEl = createElement("p", {
    class: "search-result-text",
    dangerouslySetInnerHTML: {
      __html: text,
    },
  });

  const titleEl = createElement("p", { class: "search-result-section" }, title);
  const linkEl = createElement(
    "a",
    {
      href: offsetURL(href),
      class: "search-result-link",
    },
    [titleEl, descEl]
  );
  return linkEl;
}

function createErrorCard(createElement, title, text) {
  const descEl = createElement("p", {
    class: "search-error-text",
    dangerouslySetInnerHTML: {
      __html: text,
    },
  });

  const titleEl = createElement("p", {
    class: "search-error-title",
    dangerouslySetInnerHTML: {
      __html: `<i class="bi bi-exclamation-circle search-error-icon"></i> ${title}`,
    },
  });
  const errorEl = createElement("div", { class: "search-error" }, [
    titleEl,
    descEl,
  ]);
  return errorEl;
}

function positionPanel(pos) {
  const panelEl = window.document.querySelector(
    "#quarto-search-results .aa-Panel"
  );
  const inputEl = window.document.querySelector(
    "#quarto-search .aa-Autocomplete"
  );

  if (panelEl && inputEl) {
    panelEl.style.top = `${Math.round(panelEl.offsetTop)}px`;
    if (pos === "start") {
      panelEl.style.left = `${Math.round(inputEl.left)}px`;
    } else {
      panelEl.style.right = `${Math.round(inputEl.offsetRight)}px`;
    }
  }
}

/* Highlighting */
// highlighting functions
function highlightMatch(query, text) {
  if (text) {
    const start = text.toLowerCase().indexOf(query.toLowerCase());
    if (start !== -1) {
      const startMark = "<mark class='search-match'>";
      const endMark = "</mark>";

      const end = start + query.length;
      text =
        text.slice(0, start) +
        startMark +
        text.slice(start, end) +
        endMark +
        text.slice(end);
      const startInfo = clipStart(text, start);
      const endInfo = clipEnd(
        text,
        startInfo.position + startMark.length + endMark.length
      );
      text =
        startInfo.prefix +
        text.slice(startInfo.position, endInfo.position) +
        endInfo.suffix;

      return text;
    } else {
      return text;
    }
  } else {
    return text;
  }
}

function clipStart(text, pos) {
  const clipStart = pos - 50;
  if (clipStart < 0) {
    // This will just return the start of the string
    return {
      position: 0,
      prefix: "",
    };
  } else {
    // We're clipping before the start of the string, walk backwards to the first space.
    const spacePos = findSpace(text, pos, -1);
    return {
      position: spacePos.position,
      prefix: "",
    };
  }
}

function clipEnd(text, pos) {
  const clipEnd = pos + 200;
  if (clipEnd > text.length) {
    return {
      position: text.length,
      suffix: "",
    };
  } else {
    const spacePos = findSpace(text, clipEnd, 1);
    return {
      position: spacePos.position,
      suffix: spacePos.clipped ? "â€¦" : "",
    };
  }
}

function findSpace(text, start, step) {
  let stepPos = start;
  while (stepPos > -1 && stepPos < text.length) {
    const char = text[stepPos];
    if (char === " " || char === "," || char === ":") {
      return {
        position: step === 1 ? stepPos : stepPos - step,
        clipped: stepPos > 1 && stepPos < text.length,
      };
    }
    stepPos = stepPos + step;
  }

  return {
    position: stepPos - step,
    clipped: false,
  };
}

// removes highlighting as implemented by the mark tag
function clearHighlight(searchterm, el) {
  const childNodes = el.childNodes;
  for (let i = childNodes.length - 1; i >= 0; i--) {
    const node = childNodes[i];
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (
        node.tagName === "MARK" &&
        node.innerText.toLowerCase() === searchterm.toLowerCase()
      ) {
        el.replaceChild(document.createTextNode(node.innerText), node);
      } else {
        clearHighlight(searchterm, node);
      }
    }
  }
}

/** Get all html nodes under the given `root` that don't have children. */
function getLeafNodes(root) {
  let leaves = [];

  function traverse(node) {
    if (node.childNodes.length === 0) {
      leaves.push(node);
    } else {
      node.childNodes.forEach(traverse);
    }
  }

  traverse(root);
  return leaves;
}
/** create and return `<mark>${txt}</mark>` */
const markEl = txt => {
  const el = document.createE @     Àt @ A×o€éĞœÂ…O 00LD/s6ñÑÒv õï|0MZö×.âÈá…Jo×›»@Ø]…€7`mÑ«ĞÇîP{7†ÂÁ6@-êì`8*Ãg¼±MyotBSpˆƒ2ÏT¡Iù$ƒ?€€P7 ËøU}‘·=cnä@øÁĞïW>9HDÒ  §Z°>‹qéÊOõšQƒ°­ã¬Ğı’a-W!êŒ€ÄÀ¨ôoß¤QãM6+3ĞQOŒkƒAË¥8I—Bàè¶Q‹ˆ1¥·É	ğ¯*ğ­ÂÑÃµJ!1hJiT'( á\L#¶¤/“eyòÆÂŸó-d;_\FÁ X ‘iTÊëoñ€/×l:®0È›ÀÕ›áTÀ yêX@ùDëù‡wVÑš
ÉäğEüPŸÇ8¸#‘ÁR²£İ¶H`ÏrX	õ±|"ºÿVÎpNèv;Ñ¡˜O˜@9*€ñ©ìióá‘&õİ´4ç4B]*=÷ævØï ÷2Ü„±q˜€ü†à»™°îˆËYÀ‚şaüíò32µÀÉYãœ÷ŠQÒBRñ;ÓĞRêÑtU£ÇAÚºL¨T|„àÉò~Ğ1Ô9pšû+oğnc“=’Íó!€Ó¢‹ oÜ B     Şt B Ùo¼é.·‹O ²»MD§Ü6ñoÿ ©„0÷QÙâíSácÍëÙç<@Ú”
²(_ÑÉ¸®<ğœPÓÓLXÌĞÁai€üÌˆ`º,†@&l„±ëÜ'ø‚HpÏOívK¡'­ç×¹»•€R%“G­­‘Õ/Ÿ±ûHÀƒÍSù”vãµ
é+>À§ ¢ §ZN½q‡iÒÆé7¿°ï.T:°aÀîW‚¸Àª@ı1%c¾QÊÖ­Ø%ĞÖ•€³·A)‹ÇX˜™¾àj'±t‹ò1COa¶»Mçğï¤³àBİî!ª†Û›² ãöã®åËıMw[?XéÂ„ı[Çx#Ç½Úc¾— ÑÙ(¡âÍñ@Ã„„ê0ĞÁp¸â¯zá2[›ş¡@ûWÌ©LÑ¸'‹5îÕÃPÔS'ô­°ÁpéM®m`›­Å»±,zÑ&N‡p•(÷`Àg¡vÃ`ë>Û<€ós«k&œñ‘DËÏ3šÓé°²MÔqD§]’Y\ Í|şÒæÆq6P‰`S$°00°|ŞåpaÚÒRş9¨MÀËZÚG@®ßQğQËõõĞÍé·_Ê.A8³–°¨§àK?}‘æ…1rµV"ÌÁUğ°¡4h]!^y5ıË—ˆ D     üt D ÅÚoøéŒÑNO 4GODF7ñ,¥ 	cŒ0Ñ”­Ú–ùŞáA¸+ ¨4¾@ÜËãÎPÑçñl•`ßKP•,b’ßÁ¿œÀã­s`</IÀ‡±‰ÄIÛ­w=p„RŠ¹Çã¡½ÕŠğ7«€T†ÃŞ‘ó!ÛôQˆEıÖéâ××˜C4<} $šôv#^ïq%U˜8û°1zû]vÍaé(¼1!„¬À¬eKÛæ×Qõ_%†ì¬ĞÕ\ŸûĞA‡pVh’›:àì—^Å1áæøb‡ë£ğ1‡•ıÏ³“!íëÂËa= åÒk¨áVk[Q¾ƒF[Ä`ÿY»¶ •8”ıwÙ+ñ¼P¯ûœö%0»E°ïÃèáö„6é@ıjIË!ÀÑÖDM†ëe‹P–‡¯£=xÁÎ€é˜-¥’`Œ®¶z.±¸5:NE@pÒ%iàKEş¡T7)–D5O€õ=jmYVÍ‘b¡9é2MrÆt`;^'ì¢×¦
LÃ6 …¢Æ IÜqÔ…£‹àê®°r×”ŸüHãa¸Ÿ¸	@æÀÍ[Ñòxe4QaDúãMãĞÖ¯ûiñ•A–M…ÕÊàÍ‹{RÉû11=ªœW<ğòß•*>SÆ!<Èn—À4 F     u F ‡Üo4êêë”•O ¶ÒPD—¯7ñ«X¼ “”02	ÜJjáï‰v?@Ş…BÑ+;|„ÎúPW…wÉDíÁĞ ¿^`¾1òù‹±'ê¶cl2pS¸·ıC«¡ãÌÃ='´À€Vy?0[‘8*YP-ZÚŠMÌq£H[*¸R ¦“AÚìm!qÃ¦×i‡7°sÅ¢¤²êaÇ‘‰Uë… À®Šd‘jñQ= éœ3É4Ğ—ã¨‚Cê AåUåwŒ¶ànpG ‘˜1~S‰`ğsiw]Š8!Ë-ÿ|è„Ç ç®ósj÷¯‰?GË#.C¹,ú¡ó6y×¸…ÿd  NÒNĞ‰ñZa›rµÔa0T´¨ü×Váî	"\1@ÿ}xpíötÑôa×èõRPX½æj™ÊëÁ,…“Uœ·`ŸjÌe0AG±V?úVu<ùp¶©É6Ê”¡2«ñ@Ja€÷)oŒ©‘€wg2 ˆ Änzf ğ- xC[«ñqr÷`‚9°´~yÂ¬Ua–lF”~ÀÏ\È±‰Q,p½ş7ÑĞ˜’>tıAô–shîàOØy¬q1®¬#2mí"ğ4!–/!ÅZàbéà H     8u H IŞopêHÚšO 8^RD8ñI…Ó Ö›0UÏdİşõáı%è(DÎÀ@à9šFü;4Ñ#d	c¨½©PŞŒûÁ{Aš1mI`@4ÏÊci±Å$Ba'p•ì‘@Àr¡ÁÜ±ğ]0Ö€Xïk»B²>‘/S{AaÉ\İÊ¹ÀÏoør 4( (=¶}SqaEZ;Öêr°µJëîa¥úVyµ‡”À°¯}Gî
Q[Krá¥¼ĞYj²ƒ‹€AC;t‡†Ÿ2àğxÏ0%”k1(¼'ğµKY7ê`İ!©o;.oùQ éŠ{Ö,	§#=‘‰PÊ•“¶Ûn×U¼µ|ö ™	§%Ççñøq‡éÍ²0–­ïŸ	ìÄáÌ+&‚y@‘§BÌ)ÑÑ'æ…PrF&W_ÁŠ¯ }“Ü`!IêæS±ôHº™œ3²pVFê²!O+¡ºëOés€ùÑçp¿Ê„‘M•1³¯JŒ¿LÍà^89À–ë ‰MZeŸq‹JàÄ°ö%^å8Èat9„ L
ÀÑ]¿HêÓİQJ6ŒÈ¾ĞZu1~?dARàåaÄ-àÑ$xıÓç1L(
º=ƒ	ğv\˜êØ˜!øjíQ. J     Vu J ào¬ê¦   O ºéSD‡‚8ñç±ê §£0—lÀŞ²€áÛ\F=B@âpxíò%ÑA×IÌ¬XPÛ6¢$:½	ÁÙ6uCM4`Â6’£Í½‘±c5‘õÎUp× ‚„<:¡ŸìŸ£”¬ë€Zİ^7U	o‘Mø¾Xià‹Œ`»€$µ-<¨Š°ı ª†Û …qÿãÜ%Ñ®°÷[ñ1+%aƒc$‰ˆÀ²Ô!–ıq$Qyvû‹‚DĞñ»„ÓÿA¡ —€¡®àré.*—>1»­¿hêÄÙğ÷-;Tw7‚!‡±wßõmÜ ëf9ï"bÅ3WïrÃŒtı,ËÃ¦5ÔÙ²síÂ oÃ{ü½Eñ–‚s`æÙ0Ø¦Ä— 3áªÆ…+¨Á@¤Ö1¡ŞÑ0œ“xãâPÜ&¦á„äÒÁèF¼ˆ¥Š`£'Ä›fÓ±’RzÜÃ*kp˜Ö*œÔÁ¡î’‚–UC†€û›¦rò„`‘¼#Ã70fNoÕ [¼h‚z Æ #¤‡ãoq®’`±N°8ÍBWr:aRê+R€¯ÀÓ^¶ó"‹2Qh¯à…¬ĞXIÄˆfËA°)LP Z4àSqvõ”q]1ê£ğAğğ¸šÀ!Ö€Ãù:9 L     tu L Íáoèê;f¥O <uUDÿë8ñ…Ş!1I«0Ù	àf(á¹“¤QàgÃ@ä§¤©Ş©Ñ_Ö¥0ğ›P·ªrùÁ7jÁPU-`D9U|7•±[ş¨„JpUç—Ç¸¡}üVË(€\ËQ³g`Ÿ‘kêÊpq¨M¼ã«û©‹X¢,Ó ,€(I·q‚_Şs·ê°9§˜xgB aaÌñÀI‹|À´ù*¯³õ=Q—¡„<_ÌĞİwÅ…6~Aÿ’¦z£*àôY/š1YEW¶b–ğ9q'!eó³|âf íB‹›±8»ãë(U•ƒNÒeÆß«Ş“R÷¯jäq Ö}PÓ´£ñ4“_×şn0 ™#¡áˆa š/Î	@·çRv“ÑN¹UÉà¥©PÛzqFÁFŞWƒÍ&`%&sQy™±0\:ë!$pÚfk…÷XX¡ÌKA[˜€ıeet%?<‘ÚùğQ/íÎ£^ sÕ™Ë4j  øí©'Ò1qLñ”àHÙ°zt'+uÕ¬a0ÓO7XöGÀÕ_­[B‡Q†(4CšĞŞ:a“2As²>|†WàÕ½tíUTÓ1ˆ×ÉŞ®ÖğúØš–^k!´¶5Åcå N     ’u N ão$ëbU¬ªO ¾ WDwU9ñ#!»³0§wá4–á—Êf®´D@æŞ)ÛÏ`	Ñ}t‹¶P_èÌ0«5&Á•,g
`Æ;U¡f˜±Ÿ€k\:?p[‰L5É¡[|	¥€^¹D/z·Ï‘‰ÜE‡ypìfœvûéÔº¨¨ ®yug­éq;!â¯Â&°{ò?¿£_%a?5¿äpÀ¶4ÈiyWQµÌ{é;TĞŸşÎ†cOıA]ë ¶t¥¦àvÊíì3ä1÷ÜîÁ Sğ{òş‘äË!C5ğAWñ ïşsNĞãº·C0Î_ô“ñĞ­aÛ  >8%ª«ñÒ£KNMQ0\™n‡0(áfüz4ôQ@Ê4¹tKHÑlÖŞ5qP`eXpş¹Á¤uó}õxK`§äC"Œ_±Îeúaİp÷«nâİî¡ªzì`÷ª€ÿ/$vXù‘øÏl.Ì‹/Îæ°ÆOxÉîÓz Î7Ìk4GqêE—`àc°¼N“8a µB^làÀ×`¤I”ùÛQ¤¬¡ˆ ˆĞ yJ´™Al¼-Ø²zàW
så7I1&›½Q¯D½ğ<ûk¡Ô!’\¥¦Œ‘ P     °u P Qåo`ëÀoò¯O @ŒXDï¾9ñÁ70!E¼º0]DÓâÎ?!áuaz|Æ@è¯ÁûÑ›HBş7zeP!Aâ¶ãq4ÁóĞAyíô`H>Û-»›±=¦Øğ3ûp½±N±¡9j¼8!,€`§7«Œ ‘§ÎBˆ8ÑêŒñf’G¡·Ñø#~ 0sÂÊÛ¼qÙ¿d„b°½=çà|*aŒŞdÀ¸C=áıpQÓ÷–ò–ÜĞa…Ø‡«h|A»Ğ¯Ån§"àø:MÖ8 ·1•t†nMğ½Ôàª»p!!w,ó‰Ë{ ñúš`6dm´© ÚÒ6ù|NOO2ªXÒÏ ¡¥òù€¢_ñp´7Å/+0’C=<}áD—õ¤8š@	İc‹– ıÑŠóÙjÛÅ8P"EÅf‹-Áxpp`)ÃaÑ¼%±loº¤9–p^‡ìWÍb…¡ˆîÛ–fQ½€úâw‹³ó‘¦L†-*R»}oÁÊÖù]¨=U ‘£î¯–\qˆ•˜™àwî°şÂğp±›‘aìlNdâxÀÙa›ôÌ°0QÂ»Ü½uĞb ‘§Û AÊ4ßàÙVqİ×¿1Ä¤ÙÚ£ğ~UñAä=!p8\µ= R     Îu R çoœëŠ8µO ÂZDg(:ñ_dG!ÏuÂ0Ÿá.ä‚K¬áS8¿JNG@êL4>²ÎìÑ¹å[iPã™÷<®BÁQ‚âŠÍß`Ê@uŸ±ÛËEÃ¥(ğpßñ"’-X¡,XooA€b•*'Ÿe0‘ÅÀ~Ëµ‰ “Km}lÒ†¥mgéîŸS ²l.¥ÌMqw^çR`j°ÿˆLš/aûZ,¨XÀºhFúÕ€ŠQñ" jDõcĞ#âˆóûA¶>Õh©àz«¬¿=£Š13<Ìğÿ¶ÂÇ«‘!ÿ¸h¤@ óÖ"ÃøyÆ=˜
o†üÃ”ë’d†­ÍO§OÉ~ #­ÎW™½ñÅ#<H	É0à‹wJPëá"2p*=@â@ğ’]¸õ±Ñ¨œ»ØU Päù$Ï[¡Á`¤*sEg•`«¡€r±ë±
yzç`Op -A¸ç¡fb¤Al«Ï€Ä¡y¾mÏ‘4|z ,2ÉG-øÑlD4*§b§/ yËôøqq&ì›`y°@jÕ“ÏşaÊ9YjXÀÛb’Ÿh…QàÊ“0{cĞ$ã¨Ğ±hA(Oå	Áà[£oÕ˜ü41b’ŠaPpŠğÀ“è'§!N¨Ê‰'Şé T     ìu T ÕèoØë|¤~ºO D£[Dß‘:ñı^!Y/Ê0á~Šå6W7á1o£›È@ìƒ¹o£…ŞÑ×ºŞËXÃP¥òÃTêPÁ¯7Â½œ­Ê`LCaßŞc¢±yñ²v[åp!&|¥Õ©¡õ;F"¦W€dƒ£±¼`‘ã²ºÍ‘ÈU{ğmç={:å) 4f\‘nÜqıi$¯PÚ°AÔ5“X·4aÙo'Pr’LÀ¼OŒ¤QN©áñÑëĞå’ë‰;›zAw›Íäb«àü©B¦]1Ñ£µÇäÙˆğA™¤ä8hº!İú¤U—´ õ²ª%»[| 5ì„VI,2L¾Lm¤FÀ- ¥tg£.ñ¬Õ³`ç0"…ínWdYá Íê¯Af*@Â/ÚÊfÑÆ-^ÖåÇP¦®„ŠQ¥Á¾;Æmm^º`-€/(Ä±±¨‚:*ˆşpâ§m*£l²¡DÖlìqâ€`{ñ'«‘RR¨º+ågÖÒÜ€â¿¾’Zğ
 •N38[‡qÄš?à¦°‚º¶íava¨çdpÎ©Àİc‰J>ÚQşÙ„8QĞæÅÀ¼)ÏA†˜Køë7äàİïmÍYßª1 qé qğÒŸŞíi!,N]ûò– V     
v V —êoìÚ¾Ä¿O Æ.]DWû:ñ›½u!ãèÑ0#ææêbÂá¦{·æçI@îº>¡”<ĞÑõó¬²£GrPgK"I&_Ák™®µ`ÎE$¸H¸¥± *ÚpcZá(&ç¡ÓK4ÕÜ•l€fqÄ‘‘¥öQä™«s^b©oaÇÛ—ş ¶_©ô7ì±q³›ìõı6°ƒİÙ”Ô9a·Øôs<”@À¾²X,Bˆ½Q-y2YŸ®sĞ§õŠƒ´ùAÕ€\ô\­–à~Œk’G©01o;Mt°wEğƒ{†Æ>_!»<á) ÷2ˆ}¥xy`öúQAD§oÅF4öiÊŠ¡=·Ü 'Ü!x‡yñJæû)yÅ@0d~ÂfdxÇáŞge5FŒr@ñüŸÑäJ ]ÓuPhcäEG2ˆÁÓah•Uß`¯^»ŞİÖw±FŒúl¯õÀp$8®ñH¡"J5—w_ô€X}$â†‘p(ÖÔ*˜˜^Œ	ó9ğŠ9Özä $_U|½œqb“ `>°Ä¸ÙÅèa†ÓLpvDBÀßd€õvÖ.Qé…"Øõ>Ğ¨¨ØVÆP6Aäá±æGdà_<lÅÂ 1‰Wqñ›WğD!ÕÃ¬y!
ôïl¾/B X     (v X YìoPì8Ù
ÅO Hº^DÏd;ñ9êŒ!m¢Ù0e¹AènMáíÜÙË´4Ë@ğñÃÒ…óÁÑ-{™Ç6!P)¤7ÏÅbmÁkBtÀm `PHç²©±µ<İÆÏp¥F¬\¢®¡±["ˆ‚€h_›ÖjÁ‘—2•û¡XÙÚöNİd¿Òv0ÑÔ 8YöWüãqQ:oÇLR°Åj„ Ññ>a•AÂ—–4ÀÀ×aEø×QK¤»ĞL‹ûĞi ş‹ËÍxA3fëW¯à ıÊ{L¬1Óä |ğÅ]hS!™~¸¤¥ ùjºê?»Ñ—DìÀ·cÚØ^[.ÇH¨4®‹ ©CÜLÜ}×ñèöç ‘£|0¦w—^qŒ5á¼àºJ²º@) ÔuĞÑhâ­ĞWP*D=¿ûÁzjıb½L`1=Ù“é=±ä•º¯ÖìypfÈîüxvß¡ ¾ıA}¹€	"Ş~Wœb‘şï)K¥Zê;’f³N»‚!ä¾ ™ù¨wÀ²q  æ¢àÕ°`ƒü)([ad ²{|ºÚÀáew ¯ƒQ:øş&,³,Ğj‹ğ™ĞwAB+Õ£*àáˆj½Û¤–1<>ùÁ1>ğ†N¢Ë™ïâ!è™‚Ş‰Xî Z     Fv Z îoŒì–óPÊO ÊE`DGÎ;ñ×¤!÷[á0§VéRzØáË8à‚L@ò(Iwª³Ñ1fI€ë%ĞPëüLUş{ÁÉÑ‚OÒM‹`ÒJªia¬±Sbú|ûÃpçÂ«/ v¡k;J—€jMöéÁñ‘=‰nØª ›
z?X€XŸ&HÇ© ºRC»ÊqïØñ˜›°¶+gDasª»Ğ—(ÀÂüj^®ğQiÏDHúgƒĞ+'ç÷A‘KzQ±à‚m*eQ¯Ö1«j|ÍG³¾ğ@J;àë¨!wÀYi+0 ûFBMÑ*µ(â††Äœb@øof%ÇÅ›+¥: +«–!³t5ñ†Ôª¸0èplV~ £ášZ@OØ@<O¦?J…Ñ …¤şÍ•PìÌ£¼2LoÁØ™]åC)`³÷<Iü±‚Ÿzòıã2p¨X/æcûu¡Ş1Æì‚€ìœ€ŠV>‘¬Ô1	)şCvë¹-¬ëË#JN™ Ïò™‚Çq":¥`m£°HhH‹ÍaBm‡‚0sÀãfnKèDØQXx+€pĞ,nİÚA t~Ãÿ¼MàcÕhµœ‡1Ú€$’Ç$ğÈŒ#Âo2L!Æ?PUš \     dv \ İïoÈìô–ÏO LÑaD¿7<ñuC»!é0éóøê†cá©J–ôPÎÍ@ô_Î5ha¥ÑOŸgP­UbÛ6Û‰Á'Ã*ä-v`TMmB†µ¯±ñ‡gD2ğ¸p)÷³ãš=¡m{şí€
­€l;é’û"‘[{ª*²è]:ı/ÓëL{kÖ_½ <L”HqwtjêéÉ°IÓ­I,IaQ]ßš™ÀÄ!twd
Q‡úÍ¿§DĞí­[ wAï0	#K³
àŞ‰NV²©1IzQ{ğI",XmÂM!U–²†º ı"Ê¯ÄæƒÓØLƒ¨„^À¨‘„ìƒEã˜"œé ­Qö‰k“ñ$ÀÂ_ô0*jAN‹´áx8ÕÅSşJ@O~xa:Ñ>¢fOË%æP®x(ÙâÁ6™4X;N`5úìşÊ± ©:5%ÛëpêèoÏN€¡¼¥—ˆm+€¶[‚½‘Êª_#(±âŞ›£$¨
&¸s ¤<¼HäÜq<¥§à.°Š®LBfî?a :~’ˆ¦Àågeö ü,Qvñ/Ô-ĞîP  åÅkAş½ä±[épàå!g­]j‚1xü
	c]ğ
Ë¤¸Euµ!¤å§Á ªF ^     ‚v ^ ŸñoíR(ÜÔO Î\cD7¡<ñpÒ!Ïğ0+‘Tìº‘îá‡ôO@ö–SgY—ÑmØåM3.Po®wao˜Á…8öa`ÖO0ğ	³±­Ô÷çä­pk+v6'¡K‹ì ·†Â€n)ÜpR‘ymæ^Aº°j€ NWAÙ7†w³‡T ¾Eİ]+zq+÷;9Ğ°‹Lzô…INa/|*e›ÀÆF}—#Q¥%W7U!“Ğ¯4£öAM˜2Eµ†à†Né7[µ|1ç™«&ßî7ğ‹uú˜ò!3DÒË8ûD ÿşQ‡üÜñğÍéÊD +™ÔÕáÃ –“˜ /zË`bññÂ(¬Û=00lcF˜ÈáVÓOKX$“@b­JƒôîÑ\¿( Èµ­Pp6c3fVÁ”0ĞR52s`·Ø2›´!±¾²úwLÒ¤p,y°¸9£¡šWBÇ=€€„ğÊõ‘è€='d J,5_"hL^(¾!N z†ŞŒFòqÚ'á©`œ¸°ÌU1e„Q²aşä¤Àçh\¡Y³Q”%j4(ëõĞ°38cïìÒA\K ·”àgne¥Mø1xñ3óñğL	&¯¸!‚‹:3ìÒò `      v ` aóo@í°B"ÚO PèdD¯
=ñ±œé!•ˆø0m.°ínyáe¸RígĞ@øÍØ˜JÏˆÑ‹´4WóÜP1ç§S¦ÁãkCáîK`XRóóY^¶±-ÓA«Ù¢p­_Û¹j“Ì¡)›ÚSîØ€pÏŠ Ç‚‘—_"¢XÂxá™ÉÂ576©* @?*å&;¬qÉ´yˆ¶A°Í—!;ÂfSaå÷&/ÀÈk†©Ğ=QÃPà®şĞq»$ë2uA«û&B?·à¿H!`¸O1…1CÓªŒôğÍæï‘‡o—!†}¿oÏ ÛÙtI6ÕÃØNíâ{yÄ­¼?B“ŠG ±áÅŸ7YOñ`9˜|ól0®\ë=¥Üíá4nÊĞ\JÛ@uÜ¥É£ÑzÜêğÅEuP2ëÂîóÉÁòÇkM])˜`9·PJj4V±\¼ººsÉ]pn	ñ¡$Š9¡xí“!P€JÙ…#…Ñ‘W»W& bú´E²œÆ|§*x‹( ¡OĞ Ñ¨qxª4¬à3C°ıˆ¢´$aÜÓI©”’<ÀéiSL’jÖQ²4ã8|¨ãĞrP¦ù:AºP±B·àéºcß/n1´ó×‰ØğG§¥ñú‡!`1Í¤·û b     ¾v b #õo|í]hßO ÒsfD't=ñOÉ "B 0¯Ëï"©áCï°1»´Q@ú^Ê;†zÑ©J‚{â‹Pó_¢mà´ÁAŸƒ¼Î6`ÚT¶ÌÃ²¹±Ëø®^SÎ—pï“@=®”¡«È%í€rÂ3³‘µQ^åoÊ@£É†D.*•Ğå¦Ÿÿ Â8wHğJŞqgSüŞÖœ}°ãÈşƒXaëMÅJùøÀÊÂ†VQá{i&°Ú¢Ğ3B.‘3LôA	áµQ9¹~àŠ/¨
e»"1#ÉÚv*±ğÉÑ®F<!ïÇJ.FäY ·a×(-¹¹´Å¤Ùá]Â¤EÀ;ö 3I€tP­ñşI„óú§0ğUÀ5²ğ[á	EVap#@ˆïÆXÑ˜ù¬AÃÕ<PôŸ"ª	€=ÁP_H… ½`»•nùG±úÅzıšÀp°™1‹Ğ¡Vè—™{b€˜‡V?­‘$-éq%Ê¾$¥©=V$­ğ,2õ #%#q-ˆ®`ËÍ°P¤úªÀ—aº ¯´šÕÀëjJ÷Ê!+QĞC\=ĞeÑĞ4ùgé;¡Aš}onÚàkb• ä1Ro¾ Ô¿ğĞ…(œÇ=ñ!>×_ƒ$K d     Üv d åöo¸ílw®äO TÿgDŸİ=ñíõ"©û0ñhgğÖ´á!&F‰Ó@ü;ãû,=lÑÇƒPŸÑ:Pµ¸·óÌÂÁŸÒÃ—+®!`\Wy¥-½±i	ÃŒp1È¥Àñ‹[¡åº¶¹[û€tó´‚Euã‘ÓCš(‡Òeù	ò¾™óœ•¾•ûÔ D2Ä«¹Zqò~°%ƒ¹°Q.pÈ:¡]aÉ¶’nÃ ìÀÌµ˜Û<"pQÿ¦ò]·*ĞõÈ7’{esAgÆDa3»úà ôi¾õ1Á`r,BÈmğQ«³Ë¡á!Í	‡ßÌXä “é9Î=èK¯d2…f7J÷ÖŒ}û>Yşw¥ µ°:IåFñœZpj$Øã02O•-¿Êáğ£¿Ûe–k@›:ÁèsÑ¶o’ÀeP¶T‚eÿ±Á®ö¢B­â`=tŒ¨ÕYâ±˜Ï:@Â·Ïpò)rtú“f¡4u°BŸÕt€ŞV‰‰ùˆ‘BŒ$}]æ0YÆfX‘‚İ9/ì^İ ¥úcEYm2q´¯Û°àbX°’KßÍŞz	a˜mÀ ~mÀíkA¢ÙQîRÕA$#¿ĞöÛ,bAvã}kËšıàíS`aõY1ğê¤(¥´¥ğÄ©’€Z!}ò‡NM÷ f     úv f §øoôíÊ‘ôéO ÖŠiDG>ñ‹"/"3µ03ÃñŠÀáÿ\mZWNT@şrh-ô]Ñå¼éÂÀéPwÍyQÑÁıs=`ŞY<~—[À±D‰Å¾·psü
D5#¡ÃÊ¤l’w€vá§şWÌ‘ñ5ÖkÚĞ')â9QiEÖ‹wª Æ+ƒjBq£‚tiõ°“yw¾ba§`’¢àÀÎÚ¡ôò¥‰QÒ{”²Ğ·OA“Ã~òAÅ«Óp-½vàgİnÁÈ1_ø	Ùf*ğ“•è.ó…!«KÃSÍn oqœSAi¥*€TE(•²ëtµY½vŠõnT 7õ¼=iñ:k\á<¶0tHj%Ì8áÎ>:aj¼³@®i“
IÂÑÔ31ã½õËPx	â õ™$Á>=Õ`¿RªW‹l¨±6Ùú‚é®ˆp4º²]åı¡éxí¤/‡€¨‹¼³d‘`ÙD¦#0ü¨¼Ow«àƒ1¦È· 'Ğ­gÏGqR2/³`úâ°ÔòÃğüİ{av:{Ë¦ôÀïl8M<ÔQbNFxà¬Ğ¸¾—o‰oAÔ,äY'Ç ào ^…"ØÏ1f‹°uJŒğT+‰sÃÃ!ú"…ùv£ h     w h iúo0î(¬:ïO XkD°>ñ)OF"½n0u£ó>Ì¥áİ“Ën%›Õ@ ªí^«OÑöìÏæ¯˜P9jâÿ‰DßÁ[9DNOn÷``\ÿV°Ã±¥iöxt¬vp