// =============================================================================
// GRIST "INTRA-FORM" CUSTOM WIDGET - Vue.js Version
// A configurable form that supports drag & drop ordering,
// conditional fields, rich text editing, and field validation.
// =============================================================================

const { createApp, ref, computed, reactive, onMounted, nextTick, toRaw } = Vue;

// DOMPurify configuration for XSS protection (shared across all sanitization calls)
const sanitizeConfig = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'li', 'h1', 'h2', 'h3', 'p', 'br', 'span'],
  ALLOWED_ATTR: ['href', 'target', 'style'],
  ALLOW_DATA_ATTR: false
};

// Store reference to Vue app instance for grist.ready() callback
let vueApp = null;

// Initialize Grist widget immediately (before Vue app creation)
// This must be called at the top level for Grist to properly track widget options
grist.ready({
  requiredAccess: 'full',
  onEditOptions: () => {
    if (vueApp) {
      vueApp.showConfigModal = true;
    }
  }
});

const app = createApp({
  setup() {
    // -------------------------------------------------------------------------
    // STATE
    // -------------------------------------------------------------------------
    const columns = ref([]);              // List of column IDs from current table
    const columnMetadata = ref({});       // Metadata for each column (type, choiceOptions, etc.)
    // Form configuration (fields, separators, text). Persisted via grist.setOptions.
    // Each "field" element holds the column ID as `fieldName` (historical name) :
    // Don't rename without a migration — existing saved configs in production docs
    // use this property name.
    const formElements = ref([]);
    const formData = reactive({});        // Current form values
    const errors = reactive({});          // Validation errors per field
    const pendingAttachments = reactive({}); // Temporary storage for file uploads per column

    // -------------------------------------------------------------------------
    // ATTACHMENT HANDLING
    // -------------------------------------------------------------------------

    // Format file size in human-readable format (bytes, Ko, Mo)
    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' o';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
      return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
    }

    // Trigger attachment modal input click
    function triggerFileInput(col) {
      document.getElementById('file_' + col)?.click();
    }

    // Handle file selection
    function onFileSelect(col, event) {
      const files = Array.from(event.target.files);
      const maxSize = 10 * 1024 * 1024; // 10 MB
      const maxFiles = 3;

      if (!pendingAttachments[col]) {
        pendingAttachments[col] = [];
      }

      files.forEach(file => {
        if (pendingAttachments[col].length >= maxFiles) {
          errors[col] = `Maximum ${maxFiles} pièces jointes par champ`;
          return;
        }

        if (file.size > maxSize) {
          errors[col] = `Le fichier "${file.name}" dépasse 10 Mo`;
          return;
        }

        // Prevent duplicates
        if (pendingAttachments[col].some(f => f.name === file.name && f.size === file.size)) {
          return;
        }

        pendingAttachments[col].push(file);
      });

      // Reset input to allow re-selecting same file
      event.target.value = '';
    }

    // Remove attachment from list
    function removeAttachment(col, index) {
      pendingAttachments[col].splice(index, 1);
    }

    // Upload pending attachments to Grist and return attachment IDs in list format
    async function uploadAttachments(col) {
      const files = pendingAttachments[col] || [];
      if (files.length === 0) return null;

      const attachmentIds = [];
      const tokenInfo = await grist.docApi.getAccessToken({ readOnly: false });

      for (const file of files) {
        const formData = new FormData();
        formData.append('upload', file, file.name);

        const response = await fetch(`${tokenInfo.baseUrl}/attachments?auth=${tokenInfo.token}`, {
          method: 'POST',
          body: formData,
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });

        if (!response.ok) {
          throw new Error(`Le téléchargement a échoué : ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        attachmentIds.push(result[0]);
      }

      // Return in Grist list format: ['L', id1, id2, ...]
      return ['L', ...attachmentIds];
    }

    // UI state
    const showConfigModal = ref(false);   // Whether config modal is visible
    const showOverlay = ref(false);       // Whether popup (used to edit
                                          // a label or set a condition)
                                          // overlay is visible
    const globalFont = ref('');           // Selected font family
    const globalPadding = ref('');        // Selected padding size

    // Messages
    const formErrorMessage = ref('');     // Global form error message
    const formSuccessMessage = ref('');   // Success message after submission

    // Add element panel state
    const newElementType = ref('');       // Selected type for new element
    const selectedColumn = ref('');       // Selected column for new field
    const newElementContent = ref('');    // Content for new text element

    // Drag & drop state
    const draggedIndex = ref(null);       // Index of currently dragged element
    const dragOverIndex = ref(null);      // Index of element being dragged over
    const dragPosition = ref('');         // 'top' or 'bottom' drop position

    // "Custom dropdown" select state
    // fieldName of the currently open dropdown, or null. Only one dropdown
    // can be open at a time, so a single ref is enough.
    const openDropdown = ref(null);
    // Search query typed in the search bar, keyed by fieldName so each field
    // keeps its own query in parallel (preserved when the dropdown closes/reopens).
    const searchQuery = reactive({});
    // fieldName currently loading its ref data
    // Drives the "Chargement..." indicator inside the dropdown.
    const loadingDropdown = ref(null);
    // Index of the option highlighted by the keyboard arrows, per fieldName.
    // Drives aria-activedescendant + the .active CSS class.
    const activeIndex = reactive({});
    // DOM refs to the search <input> elements, per fieldName.
    const searchInputRefs = {};
    // Current message of the aria-live="polite" region for multi-select fields,
    // keyed by fieldName. Used to announce "Beauregard ajoutée. 3 sélections."
    // and similar dynamic add/remove feedback to screen readers.
    const liveMessage = reactive({});

    // Generate a stable unique id for a formElement entry. Used as the v-for :key
    // in the main form template — otherwise two separators (content === '') or two
    // text blocks with the same content would collide and Vue would mis-patch the
    // DOM on reorder. Persisted on each element via grist.setOptions.
    function generateUid() {
      return (crypto?.randomUUID?.()) || ('uid-' + Math.random().toString(36).slice(2) + '-' + Date.now());
    }

    // "Edit popup" (used to edit text) state
    const editPopup = reactive({
      show: false,
      title: '',
      value: '',
      index: null,
      property: ''
    });

    // "Conditional question popup" ("show this field IF field X equals value Y") state
    const conditionalPopup = reactive({
      show: false,
      index: null,
      field: '',
      operator: 'equals',
      value: '',
      values: [],
      // used to show the "Delete" button in the popup
      hasExisting: false,
      // true when the selected condition field is a Ref column with too many values
      // (>200, see MAX_CONDITIONAL_VALUES) to be usable as a condition source.
      // Drives a "Cette colonne contient trop de valeurs..." warning in the popup.
      tooManyValues: false
    });

    // "Validation popup" (used to set max nb of characters in text or numeric input) state
    const validationPopup = reactive({
      show: false,
      index: null,
      maxLength: '',
      hasExisting: false
    });

    // "Ref dropdown filter popup" (filter Ref/RefList options based on another Ref field) state
    // Ex: filter "Commune" options by the selected "Département".
    const refDropdownFilterPopup = reactive({
      show: false,
      index: null,
      filterByField: '',
      eligibleFields: [],
      linkCol: null,
      linkColIsMultiple: false,
      rule: '',
      hasExisting: false
    });

    // Rich editor state
    const richEditor = ref(null);
    const colorPicker = reactive({ show: false, type: '' });
    const emojiPicker = reactive({ show: false });
    const activeFormats = reactive({ bold: false, italic: false, underline: false });

    // Editor colors palette
    const editorColors = [
      '#000000', '#434343', '#666666', '#999999', '#CCCCCC',
      '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6',
      '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899', '#F43F5E'
    ];

    // Emoji list
    const emojis = ['😀', '😊', '👍', '❤️', '⭐', '🎉', '✅', '❌', '⚠️', '💡', '📌', '🔥', '💪', '🙏', '👏', '🤝'];


    // -------------------------------------------------------------------------
    // COMPUTED PROPERTIES
    // -------------------------------------------------------------------------

    // Apply global font and padding styles to form container
    // TODO: em instead of px
    const containerStyle = computed(() => {
      let paddingX = '24px';
      switch (globalPadding.value) {
        case 'small': paddingX = '12px'; break;
        case 'medium': paddingX = '40px'; break;
        case 'large': paddingX = '64px'; break;
      }

      return {
        fontFamily: globalFont.value || 'inherit',
        paddingLeft: paddingX,
        paddingRight: paddingX
      };
    });

    // Update column dropdown to show only unused, non-formula columns
    // Called when opening the config modal or after adding/removing a field
    const availableColumns = computed(() => {
      // Get set of columns already used in the form (O(1) lookup)
      const usedColumns = new Set(
          formElements.value
              .filter(el => el.type === 'field')
              .map(el => el.fieldName)
      );

      // Filter out already used columns and formula columns (which can't be edited)
      return columns.value.filter(col => {
        if (usedColumns.has(col)) return false;
        const meta = columnMetadata.value[col];
        if (meta?.isFormula) return false;
        return true;
      });
    });

    // Get fields that can be used as conditions (single Choice or Ref)
    const eligibleFieldsForConditions = computed(() => {
      return formElements.value.filter(el => {
        if (el.type !== 'field') return false;
        const meta = columnMetadata.value[el.fieldName];
        if (!meta) return false;
        return (meta.isChoice || meta.isRef) && !meta.isMultiple;
      });
    });

    // -------------------------------------------------------------------------
    // GRIST INITIALIZATION
    // -------------------------------------------------------------------------

    onMounted(async () => {
      // Fetch table structure then load saved config
      columnMetadata.value = await getColumnMetadata();
      columns.value = Object.keys(columnMetadata.value);

      // Load form configuration from Grist widget options
      await loadConfiguration();

      // Re-render when value added to ref column (to update ref choices)
      grist.onRecords(() => {
        getColumnMetadata().then(newMeta => {
          // Preserve already-loaded ref data from previous metadata
          // (otherwise the lazy-loaded refOptions would be wiped on every onRecords,
          // making getOptionLabel fall back to displaying IDs after form submit)
          for (const colId of Object.keys(newMeta)) {
            const existing = columnMetadata.value[colId];
            if (existing?.refDataLoaded) {
              newMeta[colId].refOptions = existing.refOptions;
              newMeta[colId].rawRefData = existing.rawRefData;
              newMeta[colId].refIdToIndex = existing.refIdToIndex;
              newMeta[colId].refIdToOption = existing.refIdToOption;
              newMeta[colId].refDataLoaded = true;
            }
          }
          columnMetadata.value = newMeta;
        });
      });

      // Close dropdowns when clicking outside.
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.custom-select-display') && !e.target.closest('.custom-select-dropdown')) {
          openDropdown.value = null;
        }
      });
    });

    // -------------------------------------------------------------------------
    // COLUMN & METADATA FETCHING
    // -------------------------------------------------------------------------

    // Extract the target table name from a Ref/RefList type string.
    // "Ref:Communes"     -> "Communes"
    // "RefList:Products" -> "Products"
    // non-ref types      -> null
    function getRefTableName(type) {
      if (type.startsWith('Ref:')) return type.substring(4);
      if (type.startsWith('RefList:')) return type.substring(8);
      return null;
    }

    // Fetch detailed metadata for all columns.
    // Returns a flat object: { colId: { type, choiceOptions, isRef, refOptions, isBool, ... }, ... }
    // Every column has the same shape, fields are populated accoring to type:
    //   - Choice / ChoiceList → choiceOptions = ["A", "B", "C"], refOptions = [], ...
    //   - Ref / RefList       → choiceOptions = null,            refOptions = [] (lazy-loaded later), ...
    //   - other types         → choiceOptions = null,            refOptions = [], ...
    async function getColumnMetadata() {
      try {
        // Get current table name (eg "Table1")
        const table = grist.getTable();
        const currentTableId = await table.getTableId();

        // fetchTable(_grist_Tables_column): list of all columns across all tables
        // eg   {
        //     id: [1, 2, 3, 4, 5, 6, 7],
        //     colId: ['Nom', 'Email', 'Date', 'Montant', 'Titre', 'Prix', 'Stock'],
        //     parentId: [1, 1, 2, 2, 3, 3, 3]
        //   }
        const colsInfo = await grist.docApi.fetchTable('_grist_Tables_column');

        // fetchTable(_grist_Tables): list of all tables in the document
        // eg   {
        //     id: [1, 2, 3],  // numeric ref
        //     tableId: ['Clients', 'Commandes', 'Produits']
        //   }
        const tablesInfo = await grist.docApi.fetchTable('_grist_Tables');

        const metadata = {};

        // Convert tableId to numeric ref (eg "Clients" → 1)
        const currentTableNumericId = tablesInfo.id[tablesInfo.tableId.indexOf(currentTableId)];

        // Used for visibleCol: numeric column ID -> column info
        // Example: visibleCol=5 means "display column with id=5" for Ref fields
        const colById = {};
        for (let i = 0; i < colsInfo.id.length; i++) {
          colById[colsInfo.id[i]] = {
            colId: colsInfo.colId[i],
            parentId: colsInfo.parentId[i]
          };
        }

        // -----------------------------------------------------------------------
        // LOOP THROUGH COLUMNS BELONGING TO CURRENT TABLE
        // -----------------------------------------------------------------------
        for (let i = 0; i < colsInfo.colId.length; i++) {
          if (colsInfo.parentId[i] !== currentTableNumericId) continue;

          const colId = colsInfo.colId[i];

          // Exclude system columns (id, manualSort, gristHelper_*)
          if (colId === 'id' || colId === 'manualSort' || colId.startsWith('gristHelper')) continue;

          const type = colsInfo.type[i];  // eg: "Text", "Int", "Ref:Clients", "ChoiceList"
          let choiceOptions = null;
          let refTableName = null;

          // For Choice/ChoiceList columns: extract choices from widgetOptions JSON
          // Example: {"choices": ["Option A", "Option B", "Option C"]}
          // Note: Check type first because Grist keeps widgetOptions after column type conversion
          if ((type === 'Choice' || type === 'ChoiceList') && colsInfo.widgetOptions?.[i]) {
            try {
              const options = JSON.parse(colsInfo.widgetOptions[i]);
              if (options.choices) choiceOptions = options.choices;
            } catch (e) { }
          }

          // For Ref/RefList columns: extract target table name from type
          // "Ref:Clients" -> refTableName = "Clients", "RefList:Products" -> "Products"
          refTableName = getRefTableName(type);

          // For Ref/RefList: resolve display column name from visibleCol.
          // Actual data fetch is deferred to first dropdown open (see ensureRefDataLoaded)
          // to avoid blocking the form load for large tables (e.g. 45k communes).
          let refDisplayCol = null;
          if (refTableName) {
            const visibleColRef = colsInfo.visibleCol?.[i];
            if (visibleColRef && visibleColRef !== 0 && colById[visibleColRef]) {
              refDisplayCol = colById[visibleColRef].colId;
            }
          }

          // Store all metadata for this column
          metadata[colId] = {
            type,
            choiceOptions,                    // For Choice/ChoiceList: ["A", "B", "C"]
            label: colsInfo.label?.[i] || colId,
            isMultiple: type === 'ChoiceList' || type.startsWith('RefList:'),
            isChoice: type === 'Choice' || type === 'ChoiceList',
            isRef: type.startsWith('Ref:') || type.startsWith('RefList:'),
            refTableName,                   // Target table name for Ref/RefList
            refDisplayCol,              // Display column name (from visibleCol), resolved on data load
            refOptions: [],             // [{id, label}] populated on first dropdown open
            refDataLoaded: false,       // Whether ref data has been fetched
            isBool: type === 'Bool',
            isDate: type === 'Date',
            isDateTime: type.startsWith('DateTime:'),
            isNumeric: type === 'Numeric',
            isInt: type === 'Int',
            isFormula: colsInfo.isFormula?.[i] === true && colsInfo.formula?.[i]?.length > 0,
            isAttachment: type === 'Attachments'
          };
        }

        return metadata;
      } catch (error) {
        console.error('Erreur metadata:', error);
        return {};
      }
    }

    // -------------------------------------------------------------------------
    // CONFIGURATION PERSISTENCE
    // -------------------------------------------------------------------------

    // Load form configuration from Grist widget options
    async function loadConfiguration() {
      const options = await grist.getOptions() || {};
      const isFirstInstall = !options.initialized && !options.formElements;

      if (isFirstInstall) {
        // Auto-initialize with all editable (non-formula) columns
        const editableColumns = columns.value.filter(col => {
          const meta = columnMetadata.value[col];
          return !meta?.isFormula;
        });

        formElements.value = editableColumns.map(col => ({
          _uid: generateUid(),
          type: 'field',
          fieldName: col,
          fieldLabel: columnMetadata.value[col]?.label || col,
          required: false,
          maxLength: null,
          conditional: null
        }));
        
       // TODO : make it reactive instead
        await grist.setOptions({ initialized: true, formElements: toRaw(formElements.value) });
      } else {
        // Load existing configuration and sanitize HTML content for XSS protection
        formElements.value = (options.formElements || []).map(el => {
          // Backfill _uid for existing saved configs that don't have one yet.
          if (!el._uid) el._uid = generateUid();
          if (el.type === 'text' && el.content) {
            el.content = DOMPurify.sanitize(el.content, sanitizeConfig);
          }
          if (el.type === 'field' && el.fieldLabel) {
            el.fieldLabel = DOMPurify.sanitize(el.fieldLabel, sanitizeConfig);
          }

          // Clean up invalid properties based on current column type
          if (el.type === 'field') {
            const meta = columnMetadata.value[el.fieldName];

            // multiline: only valid for pure text fields
            if (el.multiline && meta && !isPureTextFieldByMeta(meta)) {
              delete el.multiline;
            }

            // maxLength: only valid for text/numeric/int fields
            if (el.maxLength != null && meta && !isTextOrNumericFieldByMeta(meta)) {
              delete el.maxLength;
            }

            // conditional: verify that the referenced field is still a valid condition field
            if (el.conditional) {
              const condMeta = columnMetadata.value[el.conditional.field];
              const isValidConditionField = condMeta
                && (condMeta.isChoice || condMeta.isRef)
                && !condMeta.isMultiple;
              if (!isValidConditionField) {
                delete el.conditional;
              }
            }

            // refDropdownFilter: verify that the filter-by field still exists and is Ref/RefList
            if (el.refDropdownFilter) {
              const filterMeta = columnMetadata.value[el.refDropdownFilter.filterByField];
              if (!filterMeta?.isRef) {
                delete el.refDropdownFilter;
              }
            }
          }

          return el;
        });
      }

      // Load global style settings
      globalFont.value = options.globalFont || '';
      globalPadding.value = options.globalPadding || '';

      // Initialize formData with default values for each field
      formElements.value.forEach(el => {
        if (el.type === 'field') {
          const meta = columnMetadata.value[el.fieldName];
          formData[el.fieldName] = defaultValue(meta);
        }
      });
    }

    function defaultValue(meta) {
      if (meta?.isBool) {
        return false;
      } else if (meta?.isMultiple) {
        return [];
      } else {
        return '';
      }
    }

    // Save form configuration to Grist widget options
    // Note: We use toRaw to convert Vue Proxy objects to plain JS objects
    // because Grist's setOptions() uses postMessage which cannot clone Proxy objects
    // TODO : make it reactive instead
    async function saveConfiguration() {
      await grist.setOptions({
        initialized: true,
        formElements: toRaw(formElements.value),
        globalFont: globalFont.value,
        globalPadding: globalPadding.value
      });
    }

    // -------------------------------------------------------------------------
    // ELEMENT MANAGEMENT
    // -------------------------------------------------------------------------

    // Add new element to form configuration
    // Handles column fields, separators, and text blocks
    async function addElement() {
      const type = newElementType.value;
      if (!type) return;

      if (type === 'column') {
        const col = selectedColumn.value;
        if (!col) {
          alert('Veuillez sélectionner une colonne');
          return;
        }
        // Add field element linked to this column
        const meta = columnMetadata.value[col];
        formElements.value.push({
          _uid: generateUid(),
          type: 'field',
          fieldName: col,
          fieldLabel: meta?.label || col,
          required: false,
          maxLength: null,
          conditional: null
        });
        // Initialize form data for this field
        formData[col] = defaultValue(meta);
      } else if (type === 'separator') {
        // Add horizontal separator
        formElements.value.push({ _uid: generateUid(), type: 'separator', content: '' });
      } else if (type === 'text') {
        // Add text block (allow empty content, user can edit later)
        const content = newElementContent.value.trim();
        formElements.value.push({ _uid: generateUid(), type: 'text', content: content || '' });
      }

      await saveConfiguration();

      // Reset the "Add element" panel
      newElementType.value = '';
      selectedColumn.value = '';
      newElementContent.value = '';
    }

    // Remove element from form configuration
    // Column becomes available again after removal
    async function removeElement(index) {
      formElements.value.splice(index, 1);
      await saveConfiguration();
    }

    // Toggle "required status" for a field
    async function toggleRequired(index) {
      formElements.value[index].required = !formElements.value[index].required;
      await saveConfiguration();
    }

    // -------------------------------------------------------------------------
    // DRAG & DROP REORDERING
    // -------------------------------------------------------------------------

    // Called when drag starts on an element
    function onDragStart(index, event) {
      draggedIndex.value = index;
      event.dataTransfer.effectAllowed = 'move';
    }

    // Called when drag ends (cleanup)
    function onDragEnd() {
      draggedIndex.value = null;
      dragOverIndex.value = null;
      dragPosition.value = '';
    }

    // Called when dragging over another element
    // Calculates whether to show drop indicator at top or bottom
    function onDragOver(index, event) {
      if (draggedIndex.value === null || draggedIndex.value === index) return;

      dragOverIndex.value = index;

      // Show drop indicator based on mouse position
      const rect = event.currentTarget.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      dragPosition.value = event.clientY < midpoint ? 'top' : 'bottom';
    }

    // Called when element is dropped
    // Reorders formElements array and saves configuration
    async function onDrop(index) {
      if (draggedIndex.value === null || draggedIndex.value === index) return;

      const fromIndex = draggedIndex.value;
      let toIndex = dragPosition.value === 'top' ? index : index + 1;

      // Adjust for removal of dragged element
      if (fromIndex < toIndex) toIndex--;

      // Move element in array
      const element = formElements.value.splice(fromIndex, 1)[0];
      formElements.value.splice(toIndex, 0, element);

      await saveConfiguration();
      onDragEnd();
    }

    // -------------------------------------------------------------------------
    // POPUP MANAGEMENT
    // -------------------------------------------------------------------------

    // Close all popups and overlay
    function closeAllPopups() {
      showOverlay.value = false;
      editPopup.show = false;
      conditionalPopup.show = false;
      validationPopup.show = false;
      refDropdownFilterPopup.show = false;
    }

    // Show edit popup for field label
    function editLabel(index) {
      const el = formElements.value[index];
      editPopup.title = 'Modifier le libellé';
      editPopup.value = el.fieldLabel || el.fieldName;
      editPopup.index = index;
      editPopup.property = 'fieldLabel';
      editPopup.show = true;
      showOverlay.value = true;
    }

    // Show edit popup for text content
    function editContent(index) {
      const el = formElements.value[index];
      editPopup.title = 'Modifier le contenu';
      editPopup.value = el.content || '';
      editPopup.index = index;
      editPopup.property = 'content';
      editPopup.show = true;
      showOverlay.value = true;
    }

    // Save edit popup changes (kept for compatibility)
    async function saveEdit() {
      if (editPopup.value.trim()) {
        formElements.value[editPopup.index][editPopup.property] = editPopup.value;
        await saveConfiguration();
      }
      editPopup.show = false;
      showOverlay.value = false;
    }

    // -------------------------------------------------------------------------
    // RICH TEXT EDITOR
    // -------------------------------------------------------------------------

    // Update active format states based on current selection
    // The queryCommandState() is officially obsolete/deprecated but there's no alternative...(see execCommand) 
    function updateActiveFormats() {
      activeFormats.bold = document.queryCommandState('bold');
      activeFormats.italic = document.queryCommandState('italic');
      activeFormats.underline = document.queryCommandState('underline');
    }

    // Execute a formatting command on the editor
    // The execCommand() is officially obsolete/deprecated but there's no alternative...
    function execCmd(command) {
      document.execCommand(command, false, null);
      updateActiveFormats();
      richEditor.value?.focus();
    }

    // Apply a format block (h1, h2, h3, p)
    function applyFormat(event) {
      const value = event.target.value;
      if (value) {
        document.execCommand('formatBlock', false, value);
        event.target.value = '';
        richEditor.value?.focus();
      }
    }

    // Insert a link at cursor position
    function insertLink() {
      const url = prompt('URL du lien :');
      if (url) {
        const selection = window.getSelection();
        const text = selection.toString() || url;
        const normalizedUrl = url.match(/^https?:\/\//) ? url : 'https://' + url;
        document.execCommand('insertHTML', false, `<a href="${normalizedUrl}" target="_blank">${text}</a>`);
      }
      richEditor.value?.focus();
    }

    // Toggle emoji picker visibility
    function toggleEmojiPicker() {
      emojiPicker.show = !emojiPicker.show;
      colorPicker.show = false;
    }

    // Insert emoji at cursor position
    function insertEmoji(emoji) {
      document.execCommand('insertText', false, emoji);
      emojiPicker.show = false;
      richEditor.value?.focus();
    }

    // Toggle color picker visibility
    function toggleColorPicker(type) {
      if (colorPicker.show && colorPicker.type === type) {
        colorPicker.show = false;
      } else {
        colorPicker.show = true;
        colorPicker.type = type;
      }
      emojiPicker.show = false;
    }

    // Apply color to text or background
    // For background colors, convert to rgba with 0.2 opacity for transparency
    function applyColor(command, color) {
      let finalColor = color;
      if (command === 'backColor') {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        finalColor = `rgba(${r},${g},${b},0.2)`;
      }
      document.execCommand(command, false, finalColor);
      colorPicker.show = false;
      richEditor.value?.focus();
    }

    // Remove color (reset to default)
    function removeColor(command) {
      if (command === 'foreColor') {
        document.execCommand('foreColor', false, '#000000');
      } else {
        // Using white background because 'transparent' doesn't work with partial selections
        // TODO: if adding dark mode, use the editor background color
        document.execCommand('backColor', false, '#FFFFFF');
      }
      colorPicker.show = false;
      richEditor.value?.focus();
    }

    // Handle keyboard shortcuts in editor
    function onEditorKeydown(event) {
      if (event.ctrlKey || event.metaKey) {
        switch (event.key.toLowerCase()) {
          case 'b':
            event.preventDefault();
            document.execCommand('bold');
            updateActiveFormats();
            break;
          case 'i':
            event.preventDefault();
            document.execCommand('italic');
            updateActiveFormats();
            break;
          case 'u':
            event.preventDefault();
            document.execCommand('underline');
            updateActiveFormats();
            break;
        }
      }
    }

    // Update formats on selection change
    function onEditorSelect() {
      updateActiveFormats();
    }

    // Close pickers when clicking outside of them
    function closePickersOnClickOutside(event) {
      if (!event.target.closest('.color-picker-wrapper') && !event.target.closest('.emoji-picker')) {
        colorPicker.show = false;
        emojiPicker.show = false;
      }
    }

    // Close edit popup
    function closeEditPopup() {
      editPopup.show = false;
      showOverlay.value = false;
      colorPicker.show = false;
      emojiPicker.show = false;
    }

    // Save rich editor content
    async function saveRichEdit() {
      const rawContent = richEditor.value?.innerHTML?.trim();
      if (rawContent && rawContent !== '<br>') {
        // Sanitize HTML to prevent XSS attacks
        const content = DOMPurify.sanitize(rawContent, sanitizeConfig);
        formElements.value[editPopup.index][editPopup.property] = content;
        await saveConfiguration();
      }
      closeEditPopup();
    }

    // -------------------------------------------------------------------------
    // CONDITIONAL DISPLAY POPUP
    // -------------------------------------------------------------------------

    // Show popup to configure conditional display rules for a field
    async function showConditionalPopup(index) {
      const el = formElements.value[index];
      conditionalPopup.index = index;
      conditionalPopup.tooManyValues = false;

      // Check if this field already has a conditional rule configured
      conditionalPopup.hasExisting = !!el.conditional;

      // Pre-fill if already configured
      if (el.conditional) {
        conditionalPopup.field = el.conditional.field;
        conditionalPopup.operator = el.conditional.operator || 'equals';
        conditionalPopup.value = el.conditional.value;
        await updateConditionalValues();
      } else {
        conditionalPopup.field = '';
        conditionalPopup.operator = 'equals';
        conditionalPopup.value = '';
        conditionalPopup.values = [];
      }

      conditionalPopup.show = true;
      showOverlay.value = true;
    }

    // Max values allowed in the conditional popup. The admin popup uses the native
    // <select>, which can't render thousands of options without freezing the browser.
    // TODO: replace the native select with the custom select
    const MAX_CONDITIONAL_VALUES = 200;

    // Populate dropdown with options of the selected conditional field (Ref or Choice)
    // Async because ref data may need to be lazy-loaded
    async function updateConditionalValues() {
      conditionalPopup.tooManyValues = false;

      if (!conditionalPopup.field) {
        conditionalPopup.values = [];
        return;
      }

      const meta = columnMetadata.value[conditionalPopup.field];
      if (!meta) {
        conditionalPopup.values = [];
        return;
      }

      // For Ref columns: ensure data is loaded then use refOptions
      if (meta.isRef) {
        await ensureRefDataLoaded(conditionalPopup.field);
        if (meta.refOptions.length > MAX_CONDITIONAL_VALUES) {
          conditionalPopup.tooManyValues = true;
          conditionalPopup.values = [];
          return;
        }
        conditionalPopup.values = meta.refOptions;
      } else if (meta.choiceOptions?.length > 0) {
        conditionalPopup.values = meta.choiceOptions.map(c => ({ id: c, label: c }));
      } else {
        conditionalPopup.values = [];
      }
    }

    // Save the conditional rule configuration
    async function saveConditional() {
      // Only save if both field and value are selected, otherwise clear the rule
      if (conditionalPopup.field && conditionalPopup.value) {
        formElements.value[conditionalPopup.index].conditional = {
          field: conditionalPopup.field,
          operator: conditionalPopup.operator,
          value: conditionalPopup.value
        };
      } else {
        formElements.value[conditionalPopup.index].conditional = null;
      }
      await saveConfiguration();
      conditionalPopup.show = false;
      showOverlay.value = false;
    }

    // Remove the conditional rule from this field
    async function deleteConditional() {
      formElements.value[conditionalPopup.index].conditional = null;
      await saveConfiguration();
      conditionalPopup.show = false;
      showOverlay.value = false;
    }

    // -------------------------------------------------------------------------
    // FIELD TYPE HELPERS
    // -------------------------------------------------------------------------

    // Check if metadata indicates a text or numeric field (can have maxLength validation)
    function isTextOrNumericFieldByMeta(meta) {
      if (!meta) return false;
      return !meta.isBool && !meta.isDate && !meta.isDateTime && !meta.isMultiple
        && !meta.isAttachment && !meta.isChoice && !meta.isRef;
    }

    // Check if metadata indicates a pure text field (can be multiline)
    function isPureTextFieldByMeta(meta) {
      if (!isTextOrNumericFieldByMeta(meta)) return false;
      return !meta.isNumeric && !meta.isInt;
    }

    // Check if a field is text or numeric (can have maxLength validation)
    function isTextOrNumericField(element) {
      if (element.type !== 'field') return false;
      return isTextOrNumericFieldByMeta(columnMetadata.value[element.fieldName]);
    }

    // Check if a field is pure text (can be multiline)
    function isPureTextField(element) {
      if (element.type !== 'field') return false;
      return isPureTextFieldByMeta(columnMetadata.value[element.fieldName]);
    }

    // -------------------------------------------------------------------------
    // VALIDATION POPUP (maxLength)
    // -------------------------------------------------------------------------

    // Show popup to configure maxLength validation
    function showValidationPopup(index) {
      const el = formElements.value[index];
      validationPopup.index = index;
      validationPopup.hasExisting = el.maxLength !== null && el.maxLength !== undefined;
      validationPopup.maxLength = el.maxLength || '';
      validationPopup.show = true;
      showOverlay.value = true;
    }

    // Save maxLength validation
    async function saveValidation() {
      const maxLength = validationPopup.maxLength;
      formElements.value[validationPopup.index].maxLength = maxLength ? parseInt(maxLength) : null;
      await saveConfiguration();
      validationPopup.show = false;
      showOverlay.value = false;
    }

    // Remove maxLength validation
    async function deleteValidation() {
      formElements.value[validationPopup.index].maxLength = null;
      await saveConfiguration();
      validationPopup.show = false;
      showOverlay.value = false;
    }

    // -------------------------------------------------------------------------
    // MULTILINE TOGGLE
    // -------------------------------------------------------------------------

    // Toggle multiline for a text field (displays textarea instead of input)
    async function toggleMultiline(index) {
      formElements.value[index].multiline = !formElements.value[index].multiline;
      await saveConfiguration();
    }

    // -------------------------------------------------------------------------
    // DROPDOWN FILTER (filter Ref/RefList options based on another Ref field)
    // -------------------------------------------------------------------------
    // Running example used throughout this section:
    //   Current table: "Projets" with columns:
    //     - Département (Ref:Departements)
    //     - Commune (Ref:Communes)
    //   Table "Communes" has column "Departement" (Ref:Departements) ← the "link column"
    //
    //   Goal: when filling the form, filter the Commune dropdown to only show
    //   communes belonging to the selected Departement.
    //   Generated rule: choice.Departement == $Departement

    // Check if a form element is a Ref or RefList column
    function isRefField(element) {
      if (element.type !== 'field') return false;
      return !!columnMetadata.value[element.fieldName]?.isRef;
    }

    // Open the "ref dropdown filter popup" for a given form element.
    // Fetches _grist_Tables_column on demand (only when user clicks the icon).
    // Example: user clicks icon for the "Commune" field (Ref:Communes)
    async function showRefDropdownFilterPopup(index) {
      const element = formElements.value[index];
      const meta = columnMetadata.value[element.fieldName];
      // Defensive: !refTableName should never be true when isRef is true (invariant
      // of getColumnMetadata), but guards against malformed types like "Ref:".
      if (!meta?.isRef || !meta.refTableName) return;

      refDropdownFilterPopup.index = index;
      refDropdownFilterPopup.hasExisting = !!element.refDropdownFilter;

      // Fetch all columns metadata to inspect the referenced table's structure
      const colsInfo = await grist.docApi.fetchTable('_grist_Tables_column');
      const tablesInfo = await grist.docApi.fetchTable('_grist_Tables');

      // Find Ref/RefList columns in the referenced table.
      // Example: in table "Communes", find columns like "Departement" (Ref:Departements)
      const currentRefTableName = meta.refTableName;
      const currentRefTableNumericId = tablesInfo.id[tablesInfo.tableId.indexOf(currentRefTableName)];
      const refTableCols = [];
      for (let i = 0; i < colsInfo.colId.length; i++) {
        if (colsInfo.parentId[i] !== currentRefTableNumericId) continue;
        const colType = colsInfo.type[i];
        if (colType.startsWith('Ref:') || colType.startsWith('RefList:')) {
          refTableCols.push({ colId: colsInfo.colId[i], type: colType });
        }
      }

      // Find eligible form fields: Ref/RefList fields whose referenced table
      // is pointed to by a column in the current column's referenced table.
      // Example: "Departement" (Ref:Departements) is eligible because table "Communes"
      // has a column pointing to "Departements"
      const eligible = [];
      for (const el of formElements.value) {
        if (el.type !== 'field' || el.fieldName === element.fieldName) continue;
        const elMeta = columnMetadata.value[el.fieldName];
        if (!elMeta?.isRef || !elMeta.refTableName) continue;

        const hasLink = refTableCols.some(col => getRefTableName(col.type) === elMeta.refTableName);
        if (hasLink) {
          eligible.push({ fieldName: el.fieldName, label: el.fieldLabel || el.fieldName });
        }
      }

      refDropdownFilterPopup.eligibleFields = eligible;
      // Store refTableCols for use in onRefDropdownFilterFieldChange
      refDropdownFilterPopup._refTableCols = refTableCols;

      // Pre-fill if already configured
      if (element.refDropdownFilter) {
        refDropdownFilterPopup.filterByField = element.refDropdownFilter.filterByField;
        onRefDropdownFilterFieldChange();
      } else {
        refDropdownFilterPopup.filterByField = '';
        refDropdownFilterPopup.linkCol = null;
        refDropdownFilterPopup.rule = '';
      }

      refDropdownFilterPopup.show = true;
      showOverlay.value = true;
    }

    // Called when user selects a filter-by field in the ref filter popup.
    // Auto-detects the link column in the referenced table and builds the display rule.
    // Example: user picks "Departement" → we find "Departement" (Ref:Departements)
    // in table "Communes" → rule: choice.Departement == $Departement
    function onRefDropdownFilterFieldChange() {
      const filterByField = refDropdownFilterPopup.filterByField;
      if (!filterByField) {
        refDropdownFilterPopup.linkCol = null;
        refDropdownFilterPopup.rule = '';
        return;
      }

      const filterMeta = columnMetadata.value[filterByField];
      const refTableCols = refDropdownFilterPopup._refTableCols || [];

      // Find the column in the referenced table that points to the filter field's table.
      // Example: in "Communes", find the column whose type is Ref:Departements
      const linkCol = refTableCols.find(col => getRefTableName(col.type) === filterMeta.refTableName);

      if (!linkCol) {
        refDropdownFilterPopup.linkCol = null;
        refDropdownFilterPopup.rule = '';
        return;
      }

      refDropdownFilterPopup.linkCol = linkCol;
      const linkColIsMultiple = linkCol.type.startsWith('RefList:');
      refDropdownFilterPopup.linkColIsMultiple = linkColIsMultiple;
      const filterIsMultiple = filterMeta.isMultiple;

      // Build display rule based on column types:
      // - Ref vs Ref       → choice.Departement == $Departement
      // - Ref vs RefList    → choice.Departement in $Departements
      // - RefList vs Ref    → $Departement in choice.Departements
      // - RefList vs RefList → choice.Departements ∩ $Departements
      if (linkColIsMultiple && !filterIsMultiple) {
        refDropdownFilterPopup.rule = `$${filterByField} in choice.${linkCol.colId}`;
      } else if (!linkColIsMultiple && filterIsMultiple) {
        refDropdownFilterPopup.rule = `choice.${linkCol.colId} in $${filterByField}`;
      } else if (!linkColIsMultiple && !filterIsMultiple) {
        refDropdownFilterPopup.rule = `choice.${linkCol.colId} == $${filterByField}`;
      } else {
        refDropdownFilterPopup.rule = `choice.${linkCol.colId} ∩ $${filterByField}`;
      }
    }

    // Save the ref filter configuration to the form element
    async function saveRefDropdownFilter() {
      if (refDropdownFilterPopup.filterByField && refDropdownFilterPopup.linkCol) {
        formElements.value[refDropdownFilterPopup.index].refDropdownFilter = {
          filterByField: refDropdownFilterPopup.filterByField,
          refTableLinkCol: refDropdownFilterPopup.linkCol.colId,
          linkColIsMultiple: refDropdownFilterPopup.linkColIsMultiple,
          rule: refDropdownFilterPopup.rule
        };
      } else {
        formElements.value[refDropdownFilterPopup.index].refDropdownFilter = null;
      }
      await saveConfiguration();
      refDropdownFilterPopup.show = false;
      showOverlay.value = false;
    }

    // Remove the ref filter from this field
    async function deleteRefDropdownFilter() {
      formElements.value[refDropdownFilterPopup.index].refDropdownFilter = null;
      await saveConfiguration();
      refDropdownFilterPopup.show = false;
      showOverlay.value = false;
    }

    // -------------------------------------------------------------------------
    // CONDITIONAL FIELD DISPLAY (only available for column types Choice and Ref)
    // -------------------------------------------------------------------------

    // Determines if a field should be visible based on its conditional rule
    // A conditional rule is: "show this field if [otherField] [equals/notEquals] [value]"
    // Returns true if: no condition set, or condition is satisfied
    function shouldShowField(element) {
      if (!element.conditional) return true;

      const conditionalField = element.conditional.field;    // Field we depend on (eg "Status")
      const conditionalValue = element.conditional.value;    // Expected value (eg "Active" or ref ID)
      const conditionalOperator = element.conditional.operator; // "equals" or "notEquals"

      // Get the current value of the field we depend on
      const currentValue = formData[conditionalField];
      const meta = columnMetadata.value[conditionalField];
      if (!meta) return true;

      // For Ref columns: compare numeric IDs (not display labels)
      let expectedValue = conditionalValue;
      let compareValue = currentValue;

      if (meta.isRef) {
        expectedValue = parseInt(conditionalValue);
        compareValue = currentValue ? parseInt(currentValue) : null;
      }

      // Evaluate the condition
      if (conditionalOperator === 'notEquals') {
        return compareValue !== expectedValue;
      }
      return compareValue === expectedValue;
    }

    // -------------------------------------------------------------------------
    // FORM INPUT HELPERS
    // -------------------------------------------------------------------------

    // Generate label HTML with required star if needed.
    // The star is `aria-hidden` because screen readers shouldn't read "*"
    // as if it conveyed meaning — the input itself carries `aria-required`,
    // which is what SRs announce as "obligatoire".
    function getLabelHtml(element) {
      let html = element.fieldLabel || element.fieldName;
      if (element.required) {
        html += ' <span class="required-star" aria-hidden="true">*</span>';
      }
      return html;
    }


    // Check if a field should display a select dropdown (Choice or Ref)
    function hasSelectOptions(element) {
      const meta = columnMetadata.value[element.fieldName];
      if (!meta) return false;
      return meta.isChoice || meta.isRef;
    }

    // Get options for select dropdown
    // Returns: [{id, label}, ...] for Choice, ChoiceList, Ref, RefList columns
    function getSelectOptions(element) {
      const meta = columnMetadata.value[element.fieldName];
      if (!meta) return [];

      // For Ref/RefList columns: use refOptions (id + label from referenced table)
      if (meta.refOptions?.length > 0) {
        return meta.refOptions;
      }

      // For Choice/ChoiceList columns: map choices to {id, label} format
      if (meta.choiceOptions?.length > 0) {
        return meta.choiceOptions.map(c => ({ id: c, label: c }));
      }

      return [];
    }

    // -------------------------------------------------------------------------
    // LAZY LOADING FOR REF/REFLIST DATA
    // -------------------------------------------------------------------------

    // Fetch ref table data on first dropdown open (not at form load).
    // For a 45k communes table, this avoids blocking the initial render.
    async function ensureRefDataLoaded(colId) {
      const meta = columnMetadata.value[colId];
      if (!meta?.isRef || !meta.refTableName || meta.refDataLoaded) return;

      loadingDropdown.value = colId;
      try {
        const refData = await grist.docApi.fetchTable(meta.refTableName);
        const displayColId = meta.refDisplayCol;

        // Pre-compute lowerLabel for search filter (avoids 45k toLowerCase per keystroke).
        // Sort alphabetically (locale-aware, French) so the slice(MAX_DISPLAYED_OPTIONS)
        // cap shows a meaningful slice when a ref dropdown filter narrows the list to
        // 100+ results across multiple groups (e.g. communes from 2+ départements).
        const collator = new Intl.Collator('fr');
        meta.refOptions = refData.id.map((id, idx) => {
          const label = displayColId && refData[displayColId] ? refData[displayColId][idx] : id;
          return { id, label, lowerLabel: String(label).toLowerCase() };
        }).sort((a, b) => collator.compare(String(a.label), String(b.label)));
        meta.rawRefData = refData;
        // O(1) id→index for refDropdownFilter (replaces rawRefData.id.indexOf in a 45k filter loop).
        meta.refIdToIndex = new Map(refData.id.map((id, idx) => [id, idx]));
        // O(1) id→choice for getOptionLabel (replaces .find on 45k per displayed tag).
        meta.refIdToOption = new Map(meta.refOptions.map(c => [c.id, c]));
        meta.refDataLoaded = true;
      } catch (e) {
        errors[colId] = 'Erreur lors du chargement des données';
      }
      loadingDropdown.value = null;
    }

    // -------------------------------------------------------------------------
    // CUSTOM SELECT (with search and chips)
    // -------------------------------------------------------------------------

    // For Int / Numeric columns rendered as <input type="text">, return the
    // matching `inputmode` so mobile keyboards show the right keypad and
    // screen readers can identify the field as numeric.
    function getInputMode(element) {
      const meta = columnMetadata.value[element.fieldName];
      if (meta?.isInt) return 'numeric';
      if (meta?.isNumeric) return 'decimal';
      return null;
    }

    // sr-only hint text announced via aria-describedby on numeric fields.
    // Without this, the SR would just say "modifier le texte, vierge" with
    // no indication that a number is expected.
    function getNumericHint(element) {
      const meta = columnMetadata.value[element.fieldName];
      if (meta?.isInt) return 'Valeur entière attendue';
      if (meta?.isNumeric) return 'Valeur numérique attendue';
      return null;
    }

    // aria-describedby value for date/datetime inputs.
    // Always returns the hint id — needed because native date inputs
    // are announced poorly (e.g. segments read as "NaN" when empty by WebKit/Gecko)
    function dateInputDescribedBy(element) {
      const fieldName = element.fieldName;
      const ids = ['hint_date_' + fieldName];
      if (errors[fieldName]) ids.push('err_' + fieldName);
      return ids.join(' ');
    }

    // aria-describedby for the default text input — combines the numeric hint
    // (if any) and the error message (if any).
    function textInputDescribedBy(element) {
      const fieldName = element.fieldName;
      const ids = [];
      if (getNumericHint(element)) ids.push('hint_' + fieldName);
      if (errors[fieldName]) ids.push('err_' + fieldName);
      return ids.length ? ids.join(' ') : null;
    }

    // aria-labelledby for the combobox trigger.
    //   Single : label + currently displayed value span → SR reads "Field, value, combobox"
    //   Multi  : label only (the selections are conveyed via aria-describedby + chips)
    function comboLabelledBy(element) {
      const fieldName = element.fieldName;
      const meta = columnMetadata.value[fieldName];
      if (meta?.isMultiple) return 'label_' + fieldName;
      return 'label_' + fieldName + ' value_' + fieldName;
    }

    // Build the aria-describedby attribute value for the combobox trigger.
    // Always includes :
    //   - "Avec recherche" hint, so screen-reader users know the list is filterable
    //     (otherwise they have no way to discover the search).
    // For multi-select, also :
    //   - "Sélection multiple" hint (aria-multiselectable is only announced when
    //     the SR enters the listbox, not on the combobox itself).
    //   - count helper ("3 sélections" / "Aucune sélection").
    // Plus the error message id when the field is invalid.
    function comboDescribedBy(element) {
      const fieldName = element.fieldName;
      const ids = ['search_hint_' + fieldName];
      if (columnMetadata.value[fieldName]?.isMultiple) {
        ids.push('multi_hint_' + fieldName);
        ids.push('count_' + fieldName);
      }
      if (errors[fieldName]) {
        ids.push('err_' + fieldName);
      }
      return ids.join(' ');
    }

    // Human-readable count for the multi-select sr-only span (read at the
    // combobox via aria-describedby). "X sélection(s)"
    function getCountText(element) {
      const count = (formData[element.fieldName] || []).length;
      if (count === 0) return 'Aucune sélection';
      return count + ' sélection' + (count > 1 ? 's' : '');
    }

    // Push a message into the live region for this field. Polite, atomic.
    // Only used on user-driven actions (add / remove / no result),
    // not on every keystroke.
    function announce(fieldName, message) {
      liveMessage[fieldName] = message;
      // Clear shortly after so an identical follow-up message re-triggers SR
      setTimeout(() => {
        if (liveMessage[fieldName] === message) liveMessage[fieldName] = '';
      }, 1500);
    }

    // Toggle dropdown open/close. Opens immediately and shows "Chargement..."
    // inside while ref data is being fetched (lazy load).
    // openDropdown is a single ref (not an object) so only ONE dropdown can be
    // open at a time — opening a new one automatically closes any previous one.
    async function toggleDropdown(fieldName) {
      if (openDropdown.value === fieldName) {       // this dropdown already open?
        openDropdown.value = null;                  //   yes → close it
      } else {
        openDropdown.value = fieldName;             //   no  → open it (and implicitly close any other)
        searchQuery[fieldName] = '';                // reset the search query
        activeIndex[fieldName] = 0;                 // reset the keyboard-highlighted option
        await ensureRefDataLoaded(fieldName);       // lazy load ref data if not fetched yet
        await nextTick();                           // wait for Vue to render the search input
        searchInputRefs[fieldName]?.focus();        // focus the search input
      }
    }

    // Vue template ref callback — stores the search input element by fieldName,
    // or clears it on unmount so we don't focus a detached node later.
    function setSearchInputRef(fieldName, el) {
      if (el) searchInputRefs[fieldName] = el;
      else delete searchInputRefs[fieldName];
    }

    // aria-activedescendant: id of the currently highlighted option (or null)
    function activeOptionId(element) {
      const idx = activeIndex[element.fieldName];
      if (idx == null) return null;
      return 'opt_' + element.fieldName + '_' + idx;
    }

    // Scroll the highlighted option into view (after a keyboard move)
    function scrollActiveIntoView(fieldName) {
      nextTick(() => {
        const idx = activeIndex[fieldName];
        if (idx == null) return;
        document.getElementById('opt_' + fieldName + '_' + idx)?.scrollIntoView({ block: 'nearest' });
      });
    }

    // Keyboard on the combobox trigger (when closed):
    //   Enter / Space / ArrowDown / ArrowUp → open
    //   any printable character → open and seed the search with that character
    function onSelectKeydown(element, e) {
      const fieldName = element.fieldName;
      if (openDropdown.value === fieldName) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        toggleDropdown(fieldName);
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        openDropdown.value = fieldName;
        searchQuery[fieldName] = e.key;
        activeIndex[fieldName] = 0;
        ensureRefDataLoaded(fieldName).then(() => {
          nextTick(() => searchInputRefs[fieldName]?.focus());
        });
      }
    }

    // Input handler: reset the keyboard-active option to the top of the filtered list.
    function onSearchInput(element, e) {
      const fieldName = element.fieldName;
      activeIndex[fieldName] = 0;
    }

    // Keyboard on the search input (focus lives here while dropdown is open).
    // Arrow Up/Down navigate, Enter selects, Escape closes, Tab closes and moves on,
    // Home/End jump to first/last visible option, Backspace on empty input
    // removes the last chip (multi-select only — Gmail-style convention).
    function onSearchKeydown(element, e) {
      const fieldName = element.fieldName;
      const meta = columnMetadata.value[fieldName];
      const options = getFilteredOptions(element);
      const curr = activeIndex[fieldName] ?? -1;
      const focusTrigger = () => nextTick(() => document.getElementById('combo_' + fieldName)?.focus());

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        openDropdown.value = null;
        focusTrigger();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!options.length) return;
        activeIndex[fieldName] = (curr + 1) % options.length;
        scrollActiveIntoView(fieldName);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!options.length) return;
        activeIndex[fieldName] = curr <= 0 ? options.length - 1 : curr - 1;
        scrollActiveIntoView(fieldName);
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (!options.length) return;
        activeIndex[fieldName] = 0;
        scrollActiveIntoView(fieldName);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (!options.length) return;
        activeIndex[fieldName] = options.length - 1;
        scrollActiveIntoView(fieldName);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (curr >= 0 && options[curr]) {
          selectOption(element, options[curr].id);
          // Single-select closed the dropdown — return focus to the trigger.
          // (selectOption already does this for single, but harmless to be explicit.)
          if (!meta?.isMultiple) focusTrigger();
        }
      } else if (e.key === 'Backspace' && meta?.isMultiple && !searchQuery[fieldName]) {
        // Empty input + Backspace → remove the last chip
        const current = formData[fieldName] || [];
        if (current.length > 0) {
          e.preventDefault();
          const lastIdx = current.length - 1;
          removeSelection(element, current[lastIdx], lastIdx, e);
        }
      } else if (e.key === 'Tab') {
        openDropdown.value = null; // let Tab move focus naturally
      }
    }

    // Resolve a stored ID to its display label.
    function getOptionLabel(element, value) {
      const meta = columnMetadata.value[element.fieldName];
      if (meta?.refIdToOption) {
        const opt = meta.refIdToOption.get(value);
        return opt ? opt.label : value;
      }
      const opt = getSelectOptions(element).find(o => o.id === value);
      return opt ? opt.label : value;
    }

    // Max options displayed in a dropdown (avoid rendering 45k DOM nodes)
    const MAX_DISPLAYED_OPTIONS = 100;

    // Get filtered options based on search query and optional ref dropdown filter.
    // Results are capped at MAX_DISPLAYED_OPTIONS to avoid DOM performance issues.
    // The ref dropdown filter block only runs if element.refDropdownFilter is configured.
    function getFilteredOptions(element) {
      let options = getSelectOptions(element);
      const searchBarQuery = (searchQuery[element.fieldName] || '').toLowerCase();
      if (searchBarQuery) {
        // Use pre-computed lowerLabel for ref options; fallback to toLowerCase for Choice.
        options = options.filter(o =>
          (o.lowerLabel || o.label.toLowerCase()).includes(searchBarQuery)
        );
      }

      // Apply ref dropdown filter only if configured
      const refDropdownFilter = element.refDropdownFilter;
      if (refDropdownFilter) {
        const meta = columnMetadata.value[element.fieldName];
        const filterValue = formData[refDropdownFilter.filterByField];

        if (filterValue && !(Array.isArray(filterValue) && filterValue.length === 0)) {
          const rawRefData = meta.rawRefData;
          const refIdToIndex = meta.refIdToIndex;
          if (rawRefData && refIdToIndex) {
            const linkCol = refDropdownFilter.refTableLinkCol;
            const linkColIsMultiple = refDropdownFilter.linkColIsMultiple;
            const filterIsMultiple = Array.isArray(filterValue);

            // Example: Commune (Ref:Communes) filtered by Departement (Ref:Departements)
            // For each commune option, check if its Departement matches the selected one.
            // refIdToIndex.get is O(1) vs rawRefData.id.indexOf which was O(n) → killed the n² blow-up.
            options = options.filter(opt => {
              const refIdx = refIdToIndex.get(opt.id);
              if (refIdx === undefined) return true;

              const linkValue = rawRefData[linkCol]?.[refIdx];

              if (linkColIsMultiple && !filterIsMultiple) {
                // $Departement in choice.Departements (RefList)
                if (Array.isArray(linkValue) && linkValue[0] === 'L') {
                  return linkValue.slice(1).includes(parseInt(filterValue));
                }
                return false;
              } else if (!linkColIsMultiple && filterIsMultiple) {
                // choice.Departement in $Departements
                return filterValue.map(v => parseInt(v)).includes(parseInt(linkValue));
              } else if (!linkColIsMultiple && !filterIsMultiple) {
                // choice.Departement == $Departement
                return parseInt(linkValue) === parseInt(filterValue);
              } else {
                // Both RefList: intersection
                if (Array.isArray(linkValue) && linkValue[0] === 'L') {
                  const linkIds = linkValue.slice(1).map(v => parseInt(v));
                  const filterIds = filterValue.map(v => parseInt(v));
                  return linkIds.some(id => filterIds.includes(id));
                }
                return false;
              }
            });
          }
        }
      }

      return options.slice(0, MAX_DISPLAYED_OPTIONS);
    }

    // Check if there are more options than what's displayed
    function hasMoreOptions(element) {
      return getSelectOptions(element).length > MAX_DISPLAYED_OPTIONS;
    }

    // Check if option is selected
    function isOptionSelected(fieldName, optionId) {
      const meta = columnMetadata.value[fieldName];
      if (meta?.isMultiple) {
        return (formData[fieldName] || []).includes(optionId);
      }
      return formData[fieldName] === optionId;
    }

    // Select an option (handles both single and multiple).
    // Multi-select also pushes a polite announcement ("X ajoutée/retirée, N sélection(s)")
    // for screen-reader users
    function selectOption(element, optionId) {
      const fieldName = element.fieldName;
      const meta = columnMetadata.value[fieldName];

      if (meta?.isMultiple) {
        const current = formData[fieldName] || [];
        const index = current.indexOf(optionId);
        const label = getOptionLabel(element, optionId);
        if (index > -1) {
          current.splice(index, 1);
          formData[fieldName] = [...current];
          announce(fieldName, `${label} retirée. ${getCountText(element)}.`);
        } else {
          current.push(optionId);
          formData[fieldName] = [...current];
          announce(fieldName, `${label} ajoutée. ${getCountText(element)}.`);
        }
      } else {
        // Single: select and close, focus back to the trigger.
        formData[fieldName] = optionId;
        openDropdown.value = null;
        nextTick(() => document.getElementById('combo_' + fieldName)?.focus());
      }
    }

    // Remove a selection from chips (multi-select only).
    // Manages focus after removal so the user isn't dumped back on <body>:
    //   - was the last chip → focus the previous chip
    //   - was somewhere in the middle → focus the chip now at the same index
    //   - was the only chip → focus the combobox trigger
    function removeSelection(element, value, idx, event) {
      const fieldName = element.fieldName;
      const current = formData[fieldName] || [];
      // Defensive: trust idx, but fall back to indexOf if positions ever desync.
      const removeIdx = (current[idx] === value) ? idx : current.indexOf(value);
      if (removeIdx === -1) return;

      const label = getOptionLabel(element, value);
      current.splice(removeIdx, 1);
      formData[fieldName] = [...current];
      announce(fieldName, `${label} retirée. ${getCountText(element)}.`);

      // Focus management only when removal originated from a chip interaction
      // (keyboard or click on the chip button itself). If the user removed via
      // the option list or backspace-on-empty-input, focus stays where it is.
      const fromChip = event?.target?.closest?.('.chip');
      if (!fromChip) return;

      // If the dropdown was open, close it — the user just switched to chip
      // context, leaving the search input mid-typing would be confusing.
      if (openDropdown.value === fieldName) openDropdown.value = null;

      const newCount = current.length;
      nextTick(() => {
        let focusEl;
        if (newCount === 0) {
          focusEl = document.getElementById('combo_' + fieldName);
        } else if (removeIdx >= newCount) {
          focusEl = document.getElementById('chip_' + fieldName + '_' + (newCount - 1));
        } else {
          focusEl = document.getElementById('chip_' + fieldName + '_' + removeIdx);
        }
        focusEl?.focus();
      });
    }

    // Keyboard on a chip button: Delete/Backspace remove it.
    // Enter/Space already trigger the button's native click — nothing to do.
    function onChipKeydown(element, value, idx, e) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeSelection(element, value, idx, e);
      }
    }

    // -------------------------------------------------------------------------
    // FORM VALIDATION
    // -------------------------------------------------------------------------

    // Validate a single field, return false if invalid
    // Checks: required fields, numeric format, integer format, max length
    function validateField(element) {
      const col = element.fieldName;
      const meta = columnMetadata.value[col];
      const value = formData[col];

      // Clear previous error state
      delete errors[col];

      // Required field validation
      if (element.required) {
        if (meta?.isBool && !value) {
          errors[col] = 'Ce champ doit être coché';
          return false;
        }
        if (meta?.isMultiple && (!value || value.length === 0)) {
          errors[col] = 'Ce champ est requis';
          return false;
        }
        if (!meta?.isBool && !meta?.isMultiple && (!value || value.toString().trim() === '')) {
          errors[col] = 'Ce champ est requis';
          return false;
        }
      }

      // Numeric validation
      if ((meta?.isNumeric || meta?.isInt) && value && value.toString().trim() !== '') {
        const normalizedVal = value.toString().replace(',', '.');
        const num = parseFloat(normalizedVal);
        if (isNaN(num)) {
          errors[col] = 'Valeur numérique requise';
          return false;
        }
        if (meta?.isInt && !Number.isInteger(num)) {
          errors[col] = 'Valeur entière requise';
          return false;
        }
      }

      // Max length validation (only for text/numeric fields)
      if (element.maxLength && isTextOrNumericField(element) && value && value.length > element.maxLength) {
        errors[col] = `Maximum ${element.maxLength} caractères`;
        return false;
      }

      return true;
    }

    // -------------------------------------------------------------------------
    // FORM SUBMISSION
    // -------------------------------------------------------------------------

    // Handle form submission: validate, collect values, create record, reset form
    async function submitForm() {
      // Hide any previous error/success messages
      formErrorMessage.value = '';
      formSuccessMessage.value = '';

      // Clear all errors
      Object.keys(errors).forEach(key => delete errors[key]);

      // Validate all visible fields (hidden conditional fields are skipped)
      let valid = true;
      for (const element of formElements.value) {
        if (element.type === 'field' && shouldShowField(element)) {
          if (!validateField(element)) {
            valid = false;
          }
        }
      }

      if (!valid) {
        formErrorMessage.value = 'Il y a une ou plusieurs erreurs dans le formulaire';
        return;
      }

      // Collect field values, converting to appropriate Grist types
      const fields = {};
      for (const element of formElements.value) {
        if (element.type !== 'field') continue;
        if (!shouldShowField(element)) continue;

        const col = element.fieldName;
        const meta = columnMetadata.value[col];
        let value = formData[col];

        // Skip attachments here, handled separately
        if (meta?.isAttachment) continue;

        // Boolean: return checkbox state
        if (meta?.isBool) {
          fields[col] = value;
        // ChoiceList/RefList: return Grist list format ['L', val1, val2, ...]
        } else if (meta?.isMultiple) {
          const arr = value || [];
          const values = meta.isRef ? arr.map(v => parseInt(v)) : arr;
          fields[col] = ['L', ...values];
        // Ref: return integer ID or null
        } else if (meta?.isRef) {
          fields[col] = value ? parseInt(value) : null;
        // Numeric: parse float, accepting comma as decimal separator
        } else if (meta?.isNumeric || meta?.isInt) {
          fields[col] = value ? parseFloat(value.toString().replace(',', '.')) : null;
        // Date/DateTime: convert to timestamp in seconds
        } else if (meta?.isDate || meta?.isDateTime) {
          fields[col] = value ? Math.floor(new Date(value).getTime() / 1000) : null;
        // Default (text): return sanitized string
        } else {
          fields[col] = value?.toString().trim() || null;
        }
      }

      try {
        // Upload attachments first
        for (const element of formElements.value) {
          if (element.type === 'field' && shouldShowField(element)) {
            const col = element.fieldName;
            const meta = columnMetadata.value[col];
            if (meta?.isAttachment) {
              const attachmentValue = await uploadAttachments(col);
              if (attachmentValue) {
                fields[col] = attachmentValue;
              }
            }
          }
        }

        // Create new record
        await grist.selectedTable.create({ fields });

        // Show success message
        formSuccessMessage.value = 'Votre réponse a bien été enregistrée';
        setTimeout(() => {
          formSuccessMessage.value = '';
        }, 3000);

        // Reset form: clear all inputs based on their type
        formElements.value.forEach(el => {
          if (el.type === 'field') {
            const meta = columnMetadata.value[el.fieldName];

            if (meta?.isAttachment) {
              pendingAttachments[el.fieldName] = [];
            } else {
              formData[el.fieldName] = defaultValue(meta);
            }
          }
        });
      } catch (error) {
        formErrorMessage.value = 'Erreur : ' + error.message;
      }
    }

    // -------------------------------------------------------------------------
    // RETURN ALL REACTIVE DATA AND METHODS
    // -------------------------------------------------------------------------

    return {
      // State
      columns,
      columnMetadata,
      formElements,
      formData,
      errors,
      pendingAttachments,
      showConfigModal,
      showOverlay,
      globalFont,
      globalPadding,
      formErrorMessage,
      formSuccessMessage,
      newElementType,
      selectedColumn,
      newElementContent,
      dragOverIndex,
      dragPosition,
      editPopup,
      conditionalPopup,
      refDropdownFilterPopup,
      validationPopup,
      richEditor,
      colorPicker,
      emojiPicker,
      editorColors,
      emojis,
      activeFormats,
      openDropdown,
      loadingDropdown,
      searchQuery,
      activeIndex,
      liveMessage,

      // Computed
      containerStyle,
      availableColumns,
      conditionalFields: eligibleFieldsForConditions,

      // Methods
      formatFileSize,
      triggerFileInput,
      onFileSelect,
      removeAttachment,
      saveConfiguration,
      addElement,
      removeElement,
      toggleRequired,
      onDragStart,
      onDragEnd,
      onDragOver,
      onDrop,
      closeAllPopups,
      editLabel,
      editContent,
      saveEdit,
      execCmd,
      applyFormat,
      insertLink,
      toggleEmojiPicker,
      insertEmoji,
      toggleColorPicker,
      applyColor,
      removeColor,
      onEditorKeydown,
      onEditorSelect,
      closePickersOnClickOutside,
      closeEditPopup,
      saveRichEdit,
      showConditionalPopup,
      updateConditionalValues,
      saveConditional,
      deleteConditional,
      showRefDropdownFilterPopup,
      onRefDropdownFilterFieldChange,
      saveRefDropdownFilter,
      deleteRefDropdownFilter,
      isRefField,
      isTextOrNumericField,
      isPureTextField,
      showValidationPopup,
      saveValidation,
      deleteValidation,
      toggleMultiline,
      shouldShowField,
      getLabelHtml,
      hasSelectOptions,
      getSelectOptions,
      toggleDropdown,
      setSearchInputRef,
      activeOptionId,
      onSelectKeydown,
      onSearchKeydown,
      onSearchInput,
      onChipKeydown,
      getCountText,
      comboLabelledBy,
      comboDescribedBy,
      getInputMode,
      getNumericHint,
      textInputDescribedBy,
      dateInputDescribedBy,
      getOptionLabel,
      getFilteredOptions,
      hasMoreOptions,
      isOptionSelected,
      selectOption,
      removeSelection,
      submitForm
    };
  }
});

// Mount the app and store reference for grist.ready() callback
vueApp = app.mount('#app');
