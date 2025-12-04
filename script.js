if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGrist);
} else {
  initGrist();
}

function initGrist() {
  grist.ready({ 
    requiredAccess: 'full',
    onEditOptions: () => configModal.classList.add('show')
  });
}

const fieldsContainer = document.getElementById('fields');
const addButton = document.getElementById('addBtn');
const configModal = document.getElementById('configModal');
const closeModal = document.getElementById('closeModal');
const elementType = document.getElementById('elementType');
const columnSelect = document.getElementById('columnSelect');
const elementContent = document.getElementById('elementContent');
const addElementBtn = document.getElementById('addElementBtn');
const allElementsContainer = document.getElementById('allElements');

let columns = [];
let columnMetadata = {};
let formElements = [];
let draggedElement = null;

async function loadConfiguration() {
  try {
    const options = await grist.getOptions();
    formElements = options.formElements || [];
    
    const existingFields = formElements.filter(el => el.type === 'field').map(el => el.fieldName);
    const missingColumns = columns.filter(col => !existingFields.includes(col));
    
    if (missingColumns.length > 0) {
      formElements = [...missingColumns.map(col => ({ type: 'field', fieldName: col, fieldLabel: col })), ...formElements];
      await saveConfiguration();
    }
    
    if (formElements.length === 0 && columns.length > 0) {
      formElements = columns.map(col => ({ type: 'field', fieldName: col, fieldLabel: col }));
    }
    
    renderConfigList();
    renderForm();
  } catch (e) {
    console.error('Erreur:', e);
  }
}

async function saveConfiguration() {
  try {
    await grist.setOption('formElements', formElements);
  } catch (e) {
    console.error('Erreur:', e);
  }
}

function updateColumnSelect() {
  const existingFields = formElements.filter(el => el.type === 'field').map(el => el.fieldName);
  const availableColumns = columns.filter(col => !existingFields.includes(col));
  
  columnSelect.innerHTML = '';
  
  if (availableColumns.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'Toutes les colonnes sont déjà dans le formulaire';
    opt.disabled = true;
    columnSelect.appendChild(opt);
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Sélectionner une colonne --';
    columnSelect.appendChild(opt);
    
    availableColumns.forEach(col => {
      const opt = document.createElement('option');
      opt.value = col;
      opt.textContent = col;
      columnSelect.appendChild(opt);
    });
  }
}

function renderConfigList() {
  allElementsContainer.innerHTML = '';
  
  formElements.forEach((element, index) => {
    const div = document.createElement('div');
    div.className = 'element-item';
    div.draggable = true;
    div.dataset.index = index;
    
    const dragHandle = document.createElement('div');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'element-content-wrapper';
    
    const preview = document.createElement('div');
    preview.className = 'element-preview';
    
    if (element.type === 'field') {
      preview.className = 'element-preview field';
      preview.textContent = `Colonne : ${element.fieldName}`;
      
      const labelDiv = document.createElement('div');
      labelDiv.className = 'element-field-label';
      labelDiv.textContent = 'Titre du champ :';
      
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'field-label-input';
      labelInput.value = element.fieldLabel || element.fieldName;
      labelInput.onchange = (e) => {
        element.fieldLabel = e.target.value;
        saveConfiguration();
        renderForm();
      };
      
      contentWrapper.appendChild(preview);
      contentWrapper.appendChild(labelDiv);
      contentWrapper.appendChild(labelInput);
    } else if (element.type === 'separator') {
      preview.className = 'element-preview separator';
      contentWrapper.appendChild(preview);
    } else if (element.type === 'title') {
      preview.className = 'element-preview title';
      preview.textContent = element.content;
      contentWrapper.appendChild(preview);
    } else if (element.type === 'text') {
      preview.className = 'element-preview text';
      preview.textContent = element.content;
      contentWrapper.appendChild(preview);
    }
    
    const controls = document.createElement('div');
    controls.className = 'element-controls';
    
    if (element.type !== 'field') {
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑️';
      deleteBtn.onclick = () => {
        formElements.splice(index, 1);
        saveConfiguration();
        renderConfigList();
        renderForm();
        updateColumnSelect();
      };
      controls.appendChild(deleteBtn);
    }
    
    div.appendChild(dragHandle);
    div.appendChild(contentWrapper);
    div.appendChild(controls);
    
    div.addEventListener('dragstart', function(e) {
      draggedElement = this;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    
    div.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      draggedElement = null;
    });
    
    div.addEventListener('dragover', function(e) {
      if (e.preventDefault) e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      return false;
    });
    
    div.addEventListener('drop', function(e) {
      if (e.stopPropagation) e.stopPropagation();
      
      if (draggedElement !== this) {
        const draggedIndex = parseInt(draggedElement.dataset.index);
        const targetIndex = parseInt(this.dataset.index);
        
        const temp = formElements[draggedIndex];
        formElements.splice(draggedIndex, 1);
        formElements.splice(targetIndex, 0, temp);
        
        saveConfiguration();
        renderConfigList();
        renderForm();
      }
      
      return false;
    });
    
    allElementsContainer.appendChild(div);
  });
}

elementType.addEventListener('change', () => {
  columnSelect.style.display = 'none';
  elementContent.style.display = 'none';
  
  if (elementType.value === 'column') {
    updateColumnSelect();
    columnSelect.style.display = 'block';
  } else if (elementType.value === 'separator') {
    // Rien
  } else if (elementType.value) {
    elementContent.style.display = 'block';
    elementContent.placeholder = elementType.value === 'title' ? 'Titre' : 'Texte';
  }
});

addElementBtn.addEventListener('click', () => {
  const type = elementType.value;
  if (!type) return;
  
  if (type === 'column') {
    const col = columnSelect.value;
    if (!col) {
      alert('Veuillez sélectionner une colonne');
      return;
    }
    formElements.push({ type: 'field', fieldName: col, fieldLabel: col });
  } else if (type === 'separator') {
    formElements.push({ type: 'separator', content: '' });
  } else {
    const content = elementContent.value.trim();
    if (!content) {
      alert('Veuillez saisir un contenu');
      return;
    }
    formElements.push({ type, content });
  }
  
  saveConfiguration();
  renderConfigList();
  renderForm();
  
  elementType.value = '';
  columnSelect.value = '';
  elementContent.value = '';
  columnSelect.style.display = 'none';
  elementContent.style.display = 'none';
});

closeModal.addEventListener('click', () => configModal.classList.remove('show'));
configModal.addEventListener('click', (e) => {
  if (e.target === configModal) configModal.classList.remove('show');
});

async function getColumnMetadata() {
  try {
    const table = await grist.getTable();
    const currentTableId = await table._platform.getTableId();
    const docInfo = await grist.docApi.fetchTable('_grist_Tables_column');
    const tablesInfo = await grist.docApi.fetchTable('_grist_Tables');
    const metadata = {};
    
    const currentTableNumericId = tablesInfo.id[tablesInfo.tableId.indexOf(currentTableId)];
    
    for (let i = 0; i < docInfo.colId.length; i++) {
      if (docInfo.parentId[i] !== currentTableNumericId) continue;
      
      const colId = docInfo.colId[i];
      const type = docInfo.type[i];
      let choices = null;
      let refTable = null;
      let refChoices = [];
      
      if (docInfo.widgetOptions?.[i]) {
        try {
          const options = JSON.parse(docInfo.widgetOptions[i]);
          if (options.choices) choices = options.choices;
        } catch (e) {}
      }
      
      if (type.startsWith('Ref:')) {
        refTable = type.substring(4);
      } else if (type.startsWith('RefList:')) {
        refTable = type.substring(8);
      }
      
      if (refTable) {
        try {
          const refData = await grist.docApi.fetchTable(refTable);
          refChoices = refData.id.map((id, idx) => ({
            id: id,
            label: refData[Object.keys(refData).find(k => k !== 'id' && k !== 'manualSort')]?.[idx] || id
          }));
        } catch (e) {}
      }
      
      metadata[colId] = {
        type,
        choices,
        isMultiple: type === 'ChoiceList' || type.startsWith('RefList:'),
        isRef: type.startsWith('Ref:') || type.startsWith('RefList:'),
        refTable,
        refChoices,
        isBool: type === 'Bool',
        isDate: type === 'Date' || type === 'DateTime',
        isNumeric: type === 'Numeric',
        isInt: type === 'Int'
      };
    }
    
    return metadata;
  } catch (error) {
    console.error("Erreur:", error);
    return {};
  }
}

function createInputForColumn(col, meta) {
  let inp;
  
  if (meta.isBool) {
    inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.id = `input_${col}`;
    return inp;
  }
  
  if (meta.isDate) {
    inp = document.createElement('input');
    inp.type = 'date';
    inp.id = `input_${col}`;
    return inp;
  }
  
  if (meta.isNumeric || meta.isInt) {
    inp = document.createElement('input');
    inp.type = 'text';
    inp.id = `input_${col}`;
    inp.placeholder = meta.isInt ? 'Entier' : 'Nombre';
    return inp;
  }
  
  if (meta.isMultiple) {
    const sel = document.createElement('select');
    sel.multiple = true;
    sel.id = `input_${col}`;
    const opts = meta.refChoices.length > 0 ? meta.refChoices : (meta.choices || []).map(c => ({ id: c, label: c }));
    opts.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    return sel;
  }
  
  if ((meta.choices && meta.choices.length > 0) || (meta.isRef && meta.refChoices.length > 0)) {
    inp = document.createElement('select');
    inp.id = `input_${col}`;
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '-- Sélectionner --';
    inp.appendChild(empty);
    const opts = meta.refChoices.length > 0 ? meta.refChoices : meta.choices.map(c => ({ id: c, label: c }));
    opts.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = opt.label;
      inp.appendChild(o);
    });
    return inp;
  }
  
  inp = document.createElement('input');
  inp.type = 'text';
  inp.id = `input_${col}`;
  return inp;
}

function getInputValue(col, meta) {
  const inp = document.getElementById(`input_${col}`);
  if (!inp) return null;
  
  if (meta.isBool) return inp.checked;
  
  if (meta.isMultiple) {
    const selected = Array.from(inp.selectedOptions).map(opt => opt.value);
    const values = meta.isRef ? selected.map(v => parseInt(v)) : selected;
    return ["L", ...values];
  }
  
  if (meta.isRef) return inp.value ? parseInt(inp.value) : null;
  if (meta.isNumeric || meta.isInt) return inp.value ? parseFloat(inp.value) : null;
  
  return inp.value;
}

function validateField(col, meta) {
  const inp = document.getElementById(`input_${col}`);
  const err = document.getElementById(`error_${col}`);
  
  inp.classList.remove('error');
  if (err) err.classList.remove('show');
  
  if (meta.isNumeric || meta.isInt) {
    const val = inp.value.trim();
    if (val === '') return true;
    
    const num = parseFloat(val);
    if (isNaN(num)) {
      inp.classList.add('error');
      if (err) {
        err.textContent = 'Valeur numérique requise';
        err.classList.add('show');
      }
      return false;
    }
    
    if (meta.isInt && !Number.isInteger(num)) {
      inp.classList.add('error');
      if (err) {
        err.textContent = 'Valeur entière requise';
        err.classList.add('show');
      }
      return false;
    }
  }
  
  return true;
}

function renderForm() {
  fieldsContainer.innerHTML = '';
  
  formElements.forEach(element => {
    if (element.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'separator';
      fieldsContainer.appendChild(sep);
    } else if (element.type === 'title') {
      const title = document.createElement('div');
      title.className = 'custom-title';
      title.textContent = element.content;
      fieldsContainer.appendChild(title);
    } else if (element.type === 'text') {
      const text = document.createElement('div');
      text.className = 'custom-text';
      text.textContent = element.content;
      fieldsContainer.appendChild(text);
    } else if (element.type === 'field') {
      const col = element.fieldName;
      const meta = columnMetadata[col] || {};
      
      const fieldDiv = document.createElement('div');
      fieldDiv.className = meta.isBool ? 'field checkbox-field' : 'field';
      
      const label = document.createElement('label');
      label.textContent = element.fieldLabel || col;
      
      const inp = createInputForColumn(col, meta);
      
      if (meta.isBool) {
        fieldDiv.appendChild(label);
        fieldDiv.appendChild(inp);
      } else {
        fieldDiv.appendChild(label);
        fieldDiv.appendChild(inp);
        const err = document.createElement('div');
        err.className = 'error-message';
        err.id = `error_${col}`;
        fieldDiv.appendChild(err);
      }
      
      fieldsContainer.appendChild(fieldDiv);
    }
  });
}

grist.onRecords(async (table, mappings) => {
  if (mappings) {
    columns = Object.keys(mappings).filter(col => col !== 'id');
  } else if (table && table.length > 0) {
    columns = Object.keys(table[0]).filter(col => col !== 'id');
  } else {
    return;
  }
  
  columnMetadata = await getColumnMetadata();
  await loadConfiguration();
});

addButton.addEventListener('click', async () => {
  let valid = true;
  
  formElements.forEach(element => {
    if (element.type === 'field') {
      const col = element.fieldName;
      const meta = columnMetadata[col] || {};
      if (!validateField(col, meta)) valid = false;
    }
  });
  
  if (!valid) return;
  
  const fields = {};
  formElements.forEach(element => {
    if (element.type === 'field') {
      const col = element.fieldName;
      const meta = columnMetadata[col] || {};
      fields[col] = getInputValue(col, meta);
    }
  });
  
  try {
    await grist.selectedTable.create({ fields });
    
    formElements.forEach(element => {
      if (element.type === 'field') {
        const col = element.fieldName;
        const inp = document.getElementById(`input_${col}`);
        const meta = columnMetadata[col] || {};
        
        if (meta.isBool) {
          inp.checked = false;
        } else if (meta.isMultiple) {
          Array.from(inp.options).forEach(opt => opt.selected = false);
        } else {
          inp.value = '';
        }
      }
    });
  } catch (error) {
    console.error("Erreur:", error);
    alert("Erreur: " + error.message);
  }
});